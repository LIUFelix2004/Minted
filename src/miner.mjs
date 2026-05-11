import "dotenv/config";
import fs from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Contract, JsonRpcProvider, Wallet, concat, formatEther, keccak256, toBeHex } from "ethers";
import puppeteer from "puppeteer-core";

const CONTRACT = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function currentDifficulty() view returns (uint256)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft)",
  "function mintsInBlock(uint256 blockNumber) view returns (uint256)",
  "function MAX_MINTS_PER_BLOCK() view returns (uint256)",
  "function mine(uint256 nonce)",
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const shaderCode = fs.readFileSync(join(__dirname, "hash256.wgsl"), "utf8");

const workgroups = Number.parseInt(process.env.WORKGROUPS ?? "16384", 10);
const autoSubmit = (process.env.AUTO_SUBMIT ?? "true").toLowerCase() !== "false";
const mineOnce = (process.env.MINE_ONCE ?? "false").toLowerCase() === "true";
const priorityFeeGwei = process.env.PRIORITY_FEE_GWEI ?? "2";
const maxFeeGwei = process.env.MAX_FEE_GWEI;
const retargetCheckMs = Number.parseInt(process.env.RETARGET_CHECK_MS ?? "5000", 10);
const chromePath = process.env.CHROME_PATH || findChrome();
const headless = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

function hexToBytes32(hex) {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length !== 64) throw new Error(`expected 32 bytes, got ${raw.length / 2}`);
  return Uint8Array.from(raw.match(/../g).map((x) => Number.parseInt(x, 16)));
}

function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function challengeWords(bytes) {
  if (bytes.length !== 32) throw new Error("challenge must be 32 bytes");
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24);
  }
  return out;
}

function difficultyWords(bytes) {
  if (bytes.length !== 32) throw new Error("difficulty must be 32 bytes");
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = ((bytes[4 * i] << 24) | (bytes[4 * i + 1] << 16) | (bytes[4 * i + 2] << 8) | bytes[4 * i + 3]) >>> 0;
  }
  return out;
}

function readResult(words) {
  const found = words[0] > 0;
  const nonce = new Uint8Array(32);
  if (found) {
    const lo = words[1] >>> 0;
    const hi = words[2] >>> 0;
    nonce[24] = (hi >>> 24) & 255;
    nonce[25] = (hi >>> 16) & 255;
    nonce[26] = (hi >>> 8) & 255;
    nonce[27] = hi & 255;
    nonce[28] = (lo >>> 24) & 255;
    nonce[29] = (lo >>> 16) & 255;
    nonce[30] = (lo >>> 8) & 255;
    nonce[31] = lo & 255;
  }
  const hash = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const word = words[4 + i] >>> 0;
    hash[4 * i] = (word >>> 24) & 255;
    hash[4 * i + 1] = (word >>> 16) & 255;
    hash[4 * i + 2] = (word >>> 8) & 255;
    hash[4 * i + 3] = word & 255;
  }
  return { found, nonce, hash };
}

function randomU32Pair() {
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  return [arr[0] >>> 0, arr[1] >>> 0];
}

function formatRate(hashesPerSecond) {
  if (hashesPerSecond >= 1e9) return `${(hashesPerSecond / 1e9).toFixed(2)} GH/s`;
  if (hashesPerSecond >= 1e6) return `${(hashesPerSecond / 1e6).toFixed(2)} MH/s`;
  if (hashesPerSecond >= 1e3) return `${(hashesPerSecond / 1e3).toFixed(2)} kH/s`;
  return `${hashesPerSecond.toFixed(0)} H/s`;
}

function verifyHash(challenge, nonceHex) {
  return keccak256(concat([challenge, toBeHex(BigInt(nonceHex), 32)]));
}

function hexResult(value) {
  return typeof value === "string" ? value : bytesToHex(value);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function withLocalPage(fn) {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>hash256 gpu miner</title><body>hash256 gpu miner</body>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    server.close();
  }
}

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((path) => fs.existsSync(path));
}

class WebGpuMiner {
  async init() {
    if (!globalThis.navigator?.gpu) {
      throw new Error("WebGPU is not available in this Node runtime. Use a runtime/build that exposes navigator.gpu, or port src/hash256.wgsl to CUDA/OpenCL.");
    }
    this.adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!this.adapter) throw new Error("No WebGPU adapter found.");
    this.device = await this.adapter.requestDevice();
    this.pipeline = await this.device.createComputePipelineAsync({
      layout: "auto",
      compute: { module: this.device.createShaderModule({ code: shaderCode }), entryPoint: "main" },
    });
    this.uniformBuf = this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.resultBuf = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.stagingBuf = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }, { binding: 1, resource: { buffer: this.resultBuf } }],
    });
  }

  async runBatch(challenge, difficulty, nonceLo, nonceHi) {
    const uniforms = new Uint32Array(20);
    uniforms.set(challengeWords(hexToBytes32(challenge)), 0);
    uniforms.set(difficultyWords(hexToBytes32(difficulty)), 8);
    uniforms[16] = nonceLo;
    uniforms[17] = nonceHi;
    this.device.queue.writeBuffer(this.uniformBuf, 0, uniforms);
    this.device.queue.writeBuffer(this.resultBuf, 0, new Uint32Array(12));

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();
    encoder.copyBufferToBuffer(this.resultBuf, 0, this.stagingBuf, 0, 48);
    this.device.queue.submit([encoder.finish()]);

    await this.stagingBuf.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(this.stagingBuf.getMappedRange().slice(0));
    this.stagingBuf.unmap();
    return readResult(words);
  }

  async selfTest() {
    const challenge = `0x${"00".repeat(32)}`;
    const difficulty = `0x${"ff".repeat(32)}`;
    const result = await this.runBatch(challenge, difficulty, 0, 0);
    if (!result.found) throw new Error("GPU self-test did not find nonce 0 under max difficulty.");
    const nonceHex = bytesToHex(result.nonce);
    const expected = verifyHash(challenge, nonceHex);
    const actual = bytesToHex(result.hash);
    if (expected.toLowerCase() !== actual.toLowerCase()) {
      throw new Error(`GPU self-test hash mismatch\nexpected ${expected}\nactual   ${actual}`);
    }
    console.log(`self-test ok: nonce=${nonceHex} hash=${actual}`);
  }

  async close() {}
}

class BrowserGpuMiner {
  async init() {
    if (!chromePath) {
      throw new Error("Chrome/Edge was not found. Set CHROME_PATH in .env.");
    }
    this.browser = await puppeteer.launch({
      executablePath: chromePath,
      headless,
      args: [
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan,UseSkiaRenderer",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--no-first-run",
      ],
    });
    this.page = await this.browser.newPage();
    await withLocalPage((url) => this.page.goto(url));
    await this.page.evaluate(async ({ shaderCode, workgroups }) => {
      function hexToBytes32(hex) {
        const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
        if (raw.length !== 64) throw new Error(`expected 32 bytes, got ${raw.length / 2}`);
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i++) out[i] = parseInt(raw.slice(2 * i, 2 * i + 2), 16);
        return out;
      }
      function bytesToHex(bytes) {
        return `0x${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
      }
      function challengeWords(bytes) {
        const out = new Uint32Array(8);
        for (let i = 0; i < 8; i++) {
          out[i] = bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24);
        }
        return out;
      }
      function difficultyWords(bytes) {
        const out = new Uint32Array(8);
        for (let i = 0; i < 8; i++) {
          out[i] = ((bytes[4 * i] << 24) | (bytes[4 * i + 1] << 16) | (bytes[4 * i + 2] << 8) | bytes[4 * i + 3]) >>> 0;
        }
        return out;
      }
      function readResult(words) {
        const found = words[0] > 0;
        const nonce = new Uint8Array(32);
        if (found) {
          const lo = words[1] >>> 0;
          const hi = words[2] >>> 0;
          nonce[24] = (hi >>> 24) & 255;
          nonce[25] = (hi >>> 16) & 255;
          nonce[26] = (hi >>> 8) & 255;
          nonce[27] = hi & 255;
          nonce[28] = (lo >>> 24) & 255;
          nonce[29] = (lo >>> 16) & 255;
          nonce[30] = (lo >>> 8) & 255;
          nonce[31] = lo & 255;
        }
        const hash = new Uint8Array(32);
        for (let i = 0; i < 8; i++) {
          const word = words[4 + i] >>> 0;
          hash[4 * i] = (word >>> 24) & 255;
          hash[4 * i + 1] = (word >>> 16) & 255;
          hash[4 * i + 2] = (word >>> 8) & 255;
          hash[4 * i + 3] = word & 255;
        }
        return { found, nonce: bytesToHex(nonce), hash: bytesToHex(hash) };
      }

      if (!isSecureContext) throw new Error("Chrome page is not a secure context; WebGPU requires localhost or HTTPS.");
      if (!navigator.gpu) throw new Error("Chrome launched, but navigator.gpu is unavailable.");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No WebGPU adapter found in Chrome.");
      const device = await adapter.requestDevice();
      const pipeline = await device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: device.createShaderModule({ code: shaderCode }), entryPoint: "main" },
      });
      const uniformBuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const resultBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const stagingBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuf } }, { binding: 1, resource: { buffer: resultBuf } }],
      });

      window.hash256GpuRunBatch = async (challenge, difficulty, nonceLo, nonceHi) => {
        const uniforms = new Uint32Array(20);
        uniforms.set(challengeWords(hexToBytes32(challenge)), 0);
        uniforms.set(difficultyWords(hexToBytes32(difficulty)), 8);
        uniforms[16] = nonceLo >>> 0;
        uniforms[17] = nonceHi >>> 0;
        device.queue.writeBuffer(uniformBuf, 0, uniforms);
        device.queue.writeBuffer(resultBuf, 0, new Uint32Array(12));

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
        encoder.copyBufferToBuffer(resultBuf, 0, stagingBuf, 0, 48);
        device.queue.submit([encoder.finish()]);

        await stagingBuf.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(stagingBuf.getMappedRange().slice(0));
        stagingBuf.unmap();
        return readResult(words);
      };
    }, { shaderCode, workgroups });
    console.log(`gpu backend=chrome executable="${chromePath}" headless=${headless}`);
  }

  async runBatch(challenge, difficulty, nonceLo, nonceHi) {
    return withTimeout(this.page.evaluate((args) => {
      return window.hash256GpuRunBatch(args.challenge, args.difficulty, args.nonceLo, args.nonceHi);
    }, { challenge, difficulty, nonceLo, nonceHi }), 30000, "GPU batch");
  }

  async selfTest() {
    const challenge = `0x${"00".repeat(32)}`;
    const difficulty = `0x${"ff".repeat(32)}`;
    const result = await this.runBatch(challenge, difficulty, 0, 0);
    if (!result.found) throw new Error("GPU self-test did not find nonce 0 under max difficulty.");
    const expected = verifyHash(challenge, result.nonce);
    if (expected.toLowerCase() !== result.hash.toLowerCase()) {
      throw new Error(`GPU self-test hash mismatch\nexpected ${expected}\nactual   ${result.hash}`);
    }
    console.log(`self-test ok: nonce=${result.nonce} hash=${result.hash}`);
  }

  async close() {
    await this.browser?.close();
  }
}

async function submitMine(contract, nonce) {
  const fee = {
    maxPriorityFeePerGas: ethersParseGwei(priorityFeeGwei),
  };
  if (maxFeeGwei) fee.maxFeePerGas = ethersParseGwei(maxFeeGwei);

  let gasLimit = 300000n;
  try {
    const estimate = await contract.mine.estimateGas(nonce);
    gasLimit = (estimate * 3n) / 2n;
    if (gasLimit < 200000n) gasLimit = 200000n;
    if (gasLimit > 400000n) gasLimit = 400000n;
  } catch (err) {
    console.warn(`gas estimate failed, using 300000: ${err.shortMessage ?? err.message}`);
  }

  const tx = await contract.mine(nonce, { ...fee, gasLimit });
  console.log(`submitted mine(${nonce}) tx=${tx.hash}`);
  return tx.wait();
}

function ethersParseGwei(value) {
  const [whole, frac = ""] = String(value).split(".");
  const padded = `${frac}000000000`.slice(0, 9);
  return BigInt(whole) * 1_000_000_000n + BigInt(padded);
}

async function main() {
  const miner = globalThis.navigator?.gpu ? new WebGpuMiner() : new BrowserGpuMiner();
  try {
    await miner.init();
    await miner.selfTest();
    if (process.argv.includes("--self-test")) {
      await miner.close();
      return;
    }
  } catch (err) {
    await miner.close();
    throw err;
  }

  const provider = new JsonRpcProvider(requireEnv("RPC_URL"));
  const wallet = new Wallet(requireEnv("PRIVATE_KEY"), provider);
  const contract = new Contract(CONTRACT, ABI, wallet);
  console.log(`wallet=${wallet.address}`);
  console.log(`contract=${CONTRACT}`);
  console.log(`workgroups=${workgroups}, batch=${workgroups * 64 * 16} hashes`);

  let [nonceLo, nonceHi] = randomU32Pair();
  while (true) {
    const state = await contract.miningState();
    const block = await provider.getBlockNumber();
    const inBlock = await contract.mintsInBlock(block);
    const cap = await contract.MAX_MINTS_PER_BLOCK();
    if (inBlock >= cap) {
      console.log(`block ${block} cap is full (${inBlock}/${cap}), waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      continue;
    }

    const challenge = await contract.getChallenge(wallet.address);
    const difficulty = toBeHex(state.difficulty, 32);
    const started = performance.now();
    let hashes = 0n;

    console.log(`epoch=${state.epoch} left=${state.epochBlocksLeft} reward=${formatEther(state.reward)} HASH difficulty=${difficulty.slice(0, 12)}...`);
    let lastRetargetCheck = performance.now();
    while (true) {
      const result = await miner.runBatch(challenge, difficulty, nonceLo, nonceHi);
      const batchHashes = BigInt(workgroups * 64 * 16);
      hashes += batchHashes;

      const nextLo = (nonceLo + Number(batchHashes & 0xffffffffn)) >>> 0;
      if (nextLo < nonceLo) nonceHi = (nonceHi + 1) >>> 0;
      nonceLo = nextLo;

      const elapsedSec = (performance.now() - started) / 1000;
      process.stdout.write(`\r[gpu] ${elapsedSec.toFixed(0)}s  ${hashes.toString()} hashes  ${formatRate(Number(hashes) / elapsedSec)}      `);

      if (result.found) {
        process.stdout.write("\n");
        const nonceHex = hexResult(result.nonce);
        const hashHex = hexResult(result.hash);
        const expected = verifyHash(challenge, nonceHex);
        if (expected.toLowerCase() !== hashHex.toLowerCase()) {
          throw new Error(`local verification failed: gpu=${hashHex} ethers=${expected}`);
        }
        const nonce = BigInt(nonceHex);
        console.log(`found nonce=${nonce} hash=${hashHex}`);

        if (autoSubmit) {
          const receipt = await submitMine(contract, nonce);
          console.log(`confirmed block=${receipt.blockNumber} status=${receipt.status}`);
        } else {
          console.log("AUTO_SUBMIT=false, not sending transaction.");
        }

        if (mineOnce) return;
        [nonceLo, nonceHi] = randomU32Pair();
        break;
      }

      const now = performance.now();
      if (now - lastRetargetCheck >= retargetCheckMs) {
        lastRetargetCheck = now;
        const newChallenge = await contract.getChallenge(wallet.address);
        if (newChallenge.toLowerCase() !== challenge.toLowerCase()) {
          process.stdout.write("\nchallenge rotated, retargeting...\n");
          break;
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
