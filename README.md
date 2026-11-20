# Minted GPU Miner

这是一个用于浏览器 GPU / Chrome WebGPU 后端挖矿的 Node.js 脚本集合，目前包含两个矿工：

- HASH256：`src/miner.mjs`
- HASH98 / h98hash.xyz：`src/h98-miner.mjs`

脚本不会把私钥写进代码。私钥、RPC、gas 参数都通过本地 `.env` 配置，`.env` 已加入 `.gitignore`，不要提交到仓库。

## 环境要求

- Node.js 22 或更高版本
- npm
- Chrome 或 Edge
- 可用的钱包私钥，钱包里需要有 ETH 支付 gas

安装依赖：

```powershell
npm install
```

复制配置模板：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`，填入自己的 RPC 和私钥。

## HASH98 挖矿

H98 使用的规则和 HASH256 不同：

```text
challenge = challengeFor(wallet)          // bytes16
nonce     = bytes16
valid     = sha256(challenge || nonce) 满足 difficulty
submit    = mint(bytes16 nonce)
```

自检：

```powershell
npm run h98:check
```

开始挖矿：

```powershell
npm run h98:mine
```

成功时会看到类似输出：

```text
found nonce=0x...
verifyProof=true
submitted mint(0x...) tx=0x...
confirmed block=... status=1
```

如果出现：

```text
mint simulation reverted: WalletMintLimitReached
```

说明当前钱包已经达到合约的 mint 上限，需要换钱包或停止继续挖。

推荐 `.env` 配置：

```env
H98_RPC_URLS=https://rpc.h98hash.xyz,https://ethereum-rpc.publicnode.com,https://eth.drpc.org,https://1rpc.io/eth,https://eth.llamarpc.com
H98_PRIVATE_KEY=0x你的私钥
H98_PRIORITY_FEE_GWEI=2
H98_AUTO_SUBMIT=true
H98_MINE_ONCE=false
HEADLESS=true
```

## HASH256 挖矿

自检：

```powershell
npm run check
```

开始挖矿：

```powershell
npm run mine
```

HASH256 脚本使用公开合约接口读取 challenge / difficulty，GPU 找到 nonce 后提交链上交易。

## 常见问题

### WebGPU 不可用

脚本会优先检测 Node 是否支持 `navigator.gpu`。如果 Node 不支持，会自动启动本机 Chrome / Edge 的 WebGPU 后端。

如果自动检测不到浏览器，可以在 `.env` 指定：

```env
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

Linux / Vast.ai 上可指定：

```env
CHROME_PATH=/usr/bin/google-chrome
```

### RPC 502 或超时

H98 脚本支持多个 RPC fallback。建议使用 `H98_RPC_URLS` 配置多个节点，单个节点 502 时脚本会自动重试。

### proof 有效但交易 revert

`verifyProof=true` 只代表 PoW proof 有效。`mint()` 还会检查钱包 mint 上限、mint 是否开放、是否售罄、付款是否正确等条件。脚本会在发交易前先模拟 `mint()`，避免提交注定失败的交易。

## 安全提醒

- 不要提交 `.env`
- 不要把私钥写入 README、源码或截图
- 建议使用专门的钱包运行脚本，只放少量 ETH 支付 gas
- 提交交易前请确认合约地址、RPC 和 gas 设置

<!-- felix-ai-shop:start -->

---

### 🛒 Felix AI 工具小铺

各种低价 AI 工具，稳定直供 → **[felixaitools.shop/](https://felixaitools.shop/)**

<!-- felix-ai-shop:end -->
