import "dotenv/config";
import fs from "node:fs";
import { createServer } from "node:http";
import { Contract, FallbackProvider, JsonRpcProvider, Wallet, concat, formatEther, getBytes, sha256 } from "ethers";
import puppeteer from "puppeteer-core";

const SITE = "https://www.h98hash.xyz/home";
const CONTRACT = "0x1E5adF70321CA28b3Ead70Eac545E6055E969e6f";
const ABI = [
  "error Closed()",
  "error IncorrectPayment()",
  "error InvalidProof()",
  "error SoldOut()",
  "error WalletMintLimitReached()",
  "function challengeFor(address account) view returns (bytes16)",
  "function difficulty() view returns (uint256)",
  "function getConfig() view returns ((bool mintOpen,bool marketOpen,bool listingOpen,bool buyingOpen,bool batchOpen,uint8 marketMode,uint256 difficulty,uint256 mintPrice,uint256 mintAmount,uint256 maxPublicMints,uint256 treasuryReserveMints,uint256 lotSize,uint256 minListingAmount,uint256 maxBatchSize,uint256 marketFeeBps,address feeRecipient))",
  "function mint(bytes16 nonce) payable",
  "function verifyProof(address account, bytes16 nonce) view returns (bool)",
];

const workgroups = Number.parseInt(process.env.H98_WORKGROUPS ?? "2048", 10);
const step = Number.parseInt(process.env.H98_STEP ?? "512", 10);
const autoSubmit = (process.env.H98_AUTO_SUBMIT ?? "true").toLowerCase() !== "false";
const mineOnce = (process.env.H98_MINE_ONCE ?? "false").toLowerCase() === "true";
const priorityFeeGwei = process.env.H98_PRIORITY_FEE_GWEI ?? process.env.PRIORITY_FEE_GWEI ?? "2";
const chromePath = process.env.CHROME_PATH || findChrome();
const headless = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const defaultRpcUrls = [
  "https://rpc.h98hash.xyz",
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://eth.llamarpc.com",
];

function requireEnv(name, fallbackName) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : "");
  if (!value) throw new Error(`Missing ${name}. Add it to .env.`);
  return value;
}

function rpcUrls() {
  const raw = process.env.H98_RPC_URLS || process.env.H98_RPC_URL || process.env.RPC_URL || defaultRpcUrls.join(",");
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}

function makeProvider() {
  const urls = rpcUrls();
  if (urls.length === 1) return new JsonRpcProvider(urls[0]);
  return new FallbackProvider(urls.map((url, index) => ({
    provider: new JsonRpcProvider(url),
    priority: index + 1,
    weight: 1,
    stallTimeout: 2000,
  })), 1);
}

function isTransientRpcError(err) {
  const text = `${err?.code ?? ""} ${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
  return /SERVER_ERROR|BAD_GATEWAY|502|503|504|timeout|ETIMEDOUT|ECONNRESET|failed to fetch/i.test(text);
}

function findErrorData(err) {
  if (!err || typeof err !== "object") return null;
  if (typeof err.data === "string" && err.data !== "0x") return err.data;
  if (typeof err.error?.data === "string" && err.error.data !== "0x") return err.error.data;
  if (typeof err.info?.error?.data === "string" && err.info.error.data !== "0x") return err.info.error.data;
  if (typeof err.payload?.error?.data === "string" && err.payload.error.data !== "0x") return err.payload.error.data;
  return findErrorData(err.cause);
}

function decodeContractError(contract, err) {
  const data = findErrorData(err);
  if (data) {
    try {
      return contract.interface.parseError(data)?.name ?? (err.shortMessage || err.message);
    } catch {}
  }
  const text = `${err?.shortMessage ?? ""} ${err?.message ?? ""} ${err?.error?.message ?? ""}`;
  if (/WalletMintLimitReached/i.test(text)) return "WalletMintLimitReached";
  if (/InvalidProof/i.test(text)) return "InvalidProof";
  if (/IncorrectPayment/i.test(text)) return "IncorrectPayment";
  if (/SoldOut/i.test(text)) return "SoldOut";
  if (/Closed/i.test(text)) return "Closed";
  if (/Reverted|execution reverted|Failed in pending block/i.test(text)) return "UnknownRevert";
  return err?.shortMessage || err?.message || "UnknownError";
}

async function retryRpc(label, fn, attempts = 5) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransientRpcError(err) || i === attempts) break;
      const wait = 1000 * i;
      console.warn(`${label} RPC error (${err.shortMessage ?? err.message}); retrying in ${wait / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((path) => fs.existsSync(path));
}

function parseGwei(value) {
  const [whole, frac = ""] = String(value).split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(`${frac}000000000`.slice(0, 9));
}

function hex(bytes) {
  return `0x${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function formatRate(hps) {
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} GH/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(2)} kH/s`;
  return `${hps.toFixed(0)} H/s`;
}

function difficultyMasks(bits) {
  const out = new Int32Array(2);
  if (bits > 32) {
    out[0] = -1;
    out[1] = -1 << (64 - bits);
  } else {
    out[0] = -1 << (32 - bits);
  }
  return new Uint32Array(out.buffer);
}

function wordsFromChallenge(challenge) {
  const bytes = getBytes(challenge);
  if (bytes.length !== 16) throw new Error(`challengeFor returned ${bytes.length} bytes, expected 16`);
  const words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  for (let i = 0; i < 4; i++) words[i] = bswap32(words[i]);
  return Array.from(words);
}

function bswap32(x) {
  return (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x & 0xff0000) >>> 8) | (x >>> 24)) >>> 0;
}

async function loadShaderTemplate() {
  const html = await fetch(SITE).then((r) => r.text());
  const script = html.match(/<script[^>]+src="([^"]*index-[^"]+\.js)"/)?.[1];
  if (!script) throw new Error("Could not find H98 app bundle.");
  const url = new URL(script, SITE).href;
  const js = await fetch(url).then((r) => r.text());
  const match = js.match(/var HT=`([\s\S]*?)`,UT=/);
  if (!match) throw new Error("Could not extract H98 WebGPU shader from app bundle.");
  return match[1];
}

async function withLocalPage(fn) {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>h98 gpu miner</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    server.close();
  }
}

class H98GpuMiner {
  async init() {
    if (!chromePath) throw new Error("Chrome/Edge was not found. Set CHROME_PATH in .env.");
    const shaderTemplate = await loadShaderTemplate();
    this.browser = await puppeteer.launch({
      executablePath: chromePath,
      headless,
      args: [
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--no-first-run",
        "--no-sandbox",
      ],
    });
    this.page = await this.browser.newPage();
    await withLocalPage((url) => this.page.goto(url));
    await this.page.evaluate(({ shaderTemplate, workgroups, step }) => {
      function bswap32(x) {
        return (((x & 255) << 24) | ((x & 65280) << 8) | ((x & 16711680) >>> 8) | (x >>> 24)) >>> 0;
      }
      function hexFromWords(words) {
        const swapped = new Uint32Array(words.map((x) => bswap32(x >>> 0)));
        const bytes = new Uint8Array(swapped.buffer);
        return `0x${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
      }
      function renderTemplate(tpl, values) {
        return tpl.replace(/__(\w+)__/g, (_, key) => String(values[key]));
      }
      if (!isSecureContext) throw new Error("WebGPU requires localhost or HTTPS.");
      if (!navigator.gpu) throw new Error("Chrome launched, but navigator.gpu is unavailable.");

      window.h98Init = async (challengeWords, masks) => {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) throw new Error("No WebGPU adapter found.");
        const device = await adapter.requestDevice();
        const random = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
        const shader = renderTemplate(shaderTemplate, {
          W0: challengeWords[0],
          W1: challengeWords[1],
          W2: challengeWords[2],
          W3: challengeWords[3],
          W4: random,
          MASK0: masks[0],
          MASK1: masks[1],
          WORKGROUP_SIZE: 64,
        });
        const module = device.createShaderModule({ code: shader });
        const pipeline = device.createComputePipeline({ layout: "auto", compute: { module } });
        const uniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const resultBuf = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const readBuf = device.createBuffer({ size: 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniformBuf } }, { binding: 1, resource: { buffer: resultBuf } }],
        });
        window.h98Ctx = { device, pipeline, uniformBuf, resultBuf, readBuf, bindGroup, random, w5: 0 };
      };

      window.h98RunBatch = async () => {
        const ctx = window.h98Ctx;
        const input = new Uint32Array(4);
        input[0] = step;
        input[1] = ctx.w5 >>> 0;
        ctx.device.queue.writeBuffer(ctx.uniformBuf, 0, input);
        ctx.device.queue.writeBuffer(ctx.resultBuf, 0, new Uint32Array(2));

        const encoder = ctx.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(ctx.pipeline);
        pass.setBindGroup(0, ctx.bindGroup);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
        encoder.copyBufferToBuffer(ctx.resultBuf, 0, ctx.readBuf, 0, 8);
        ctx.device.queue.submit([encoder.finish()]);

        await ctx.readBuf.mapAsync(GPUMapMode.READ);
        const result = new Uint32Array(ctx.readBuf.getMappedRange().slice(0));
        ctx.readBuf.unmap();
        const w5 = ctx.w5 >>> 0;
        ctx.w5 = (ctx.w5 + 1) >>> 0;
        if (result[0]) {
          return { found: true, nonce: hexFromWords([ctx.random, w5, result[0], result[1]]) };
        }
        return { found: false };
      };
    }, { shaderTemplate, workgroups, step });
    console.log(`gpu backend=chrome executable="${chromePath}" headless=${headless}`);
  }

  async prepare(challenge, difficulty) {
    await this.page.evaluate(({ challengeWords, masks }) => window.h98Init(challengeWords, masks), {
      challengeWords: wordsFromChallenge(challenge),
      masks: Array.from(difficultyMasks(Number(difficulty))),
    });
  }

  async runBatch() {
    return this.page.evaluate(() => window.h98RunBatch());
  }

  async close() {
    await this.browser?.close();
  }
}

async function submitMint(contract, nonce, mintPrice, provider) {
  try {
    await retryRpc("simulate mint", () => contract.mint.staticCall(nonce, { value: mintPrice }));
  } catch (err) {
    const decoded = decodeContractError(contract, err);
    const fatal = ["WalletMintLimitReached", "SoldOut", "Closed"].includes(decoded);
    const error = new Error(`mint simulation reverted: ${decoded}`);
    error.decoded = decoded;
    error.fatal = fatal;
    throw error;
  }

  let gasLimit = 250000n;
  try {
    const estimate = await retryRpc("estimateGas", () => contract.mint.estimateGas(nonce, { value: mintPrice }));
    gasLimit = (estimate * 3n) / 2n;
  } catch (err) {
    console.warn(`gas estimate failed, using 250000: ${err.shortMessage ?? err.message}`);
  }
  const priority = parseGwei(priorityFeeGwei);
  const feeData = await retryRpc("getFeeData", () => provider.getFeeData());
  const baseMax = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const maxFeePerGas = baseMax > priority ? baseMax + priority : priority * 2n;
  let tx;
  try {
    tx = await retryRpc("send mint", () => contract.mint(nonce, {
      value: mintPrice,
      gasLimit,
      maxPriorityFeePerGas: priority,
      maxFeePerGas,
    }));
  } catch (err) {
    const decoded = decodeContractError(contract, err);
    const error = new Error(`send mint reverted: ${decoded}`);
    error.decoded = decoded;
    error.fatal = ["WalletMintLimitReached", "SoldOut", "Closed"].includes(decoded);
    throw error;
  }
  console.log(`submitted mint(${nonce}) tx=${tx.hash}`);
  return retryRpc("wait receipt", () => tx.wait(), 10);
}

async function main() {
  const miner = new H98GpuMiner();
  try {
    await miner.init();
    if (process.argv.includes("--self-test")) {
      const challenge = "0x00000000000000000000000000000000";
      const difficulty = 8n;
      await miner.prepare(challenge, difficulty);
      for (let i = 0; i < 1000; i++) {
        const result = await miner.runBatch();
        if (result.found) {
          const digest = sha256(concat([challenge, result.nonce]));
          console.log(`self-test ok: nonce=${result.nonce} sha256=${digest}`);
          await miner.close();
          return;
        }
      }
      throw new Error("self-test did not find a low-difficulty nonce");
    }

    const provider = makeProvider();
    const wallet = new Wallet(requireEnv("H98_PRIVATE_KEY", "PRIVATE_KEY"), provider);
    const contract = new Contract(CONTRACT, ABI, wallet);
    console.log(`wallet=${wallet.address}`);
    console.log(`contract=${CONTRACT}`);
    console.log(`workgroups=${workgroups}, step=${step}, batch=${workgroups * 64 * step} hashes`);

    while (true) {
      const [challenge, config] = await retryRpc("read mining config", () => Promise.all([
        contract.challengeFor(wallet.address),
        contract.getConfig(),
      ]));
      const difficulty = config.difficulty;
      const mintPrice = config.mintPrice;
      if (!config.mintOpen) {
        console.log("mint is currently closed, waiting 15s...");
        await new Promise((resolve) => setTimeout(resolve, 15000));
        continue;
      }
      await miner.prepare(challenge, difficulty);
      console.log(`challenge=${challenge} difficulty=${difficulty} mintPrice=${formatEther(mintPrice)} ETH`);
      const started = performance.now();
      let hashes = 0n;

      while (true) {
        const result = await miner.runBatch();
        hashes += BigInt(workgroups * 64 * step);
        const elapsed = (performance.now() - started) / 1000;
        process.stdout.write(`\r[gpu] ${elapsed.toFixed(0)}s  ${hashes.toString()} hashes  ${formatRate(Number(hashes) / elapsed)}      `);

        if (!result.found) continue;
        process.stdout.write("\n");
        const valid = await retryRpc("verifyProof", () => contract.verifyProof(wallet.address, result.nonce));
        const digest = sha256(concat([challenge, result.nonce]));
        console.log(`found nonce=${result.nonce} sha256=${digest} verifyProof=${valid}`);
        if (!valid) {
          console.log("proof is stale or invalid, retargeting...");
          break;
        }
        if (autoSubmit) {
          try {
            const receipt = await submitMint(contract, result.nonce, mintPrice, provider);
            console.log(`confirmed block=${receipt.blockNumber} status=${receipt.status}`);
          } catch (err) {
            console.error(err.message);
            if (err.decoded === "WalletMintLimitReached") {
              console.error("This wallet appears to have reached the contract mint limit. Stopping miner.");
              return;
            }
            if (err.fatal) return;
            console.error("Proof could not be submitted; retargeting and continuing.");
            break;
          }
        } else {
          console.log("H98_AUTO_SUBMIT=false, not sending transaction.");
        }
        if (mineOnce) return;
        break;
      }
    }
  } finally {
    await miner.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
