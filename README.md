# 西柚英语 · 作业自动朗读 (XiYou English Auto-Read)

自动完成「西柚英语个人版」里的作业：打开某份作业的「作业详情」后，脚本会**自动识别里面每一项内容的题型并完成**。
支持 **单词朗读、句子积累朗读、课文朗读、看义选词、单元检测、故事复述、模仿朗读、趣味配音** 等多类；
核心是：识别题型 → 读取内容 → 把正确发音/答案回放给虚拟麦克风 → 让 App 评分 → 切下一项，直到整份作业完成。
另附**一键安装程序**（自动装 VB-Cable / Node.js / .NET6 与自动程序）与**自动清理缓存录音**。

> ⚠️ 免责声明：本项目是把 App 自己的标准发音“喂”给它自己评分，本质是绕过朗读练习。
> 仅供学习 CDP / WebAudio / 虚拟声卡等技术原理使用，请勿用于真实作业提交。

---

## 支持的题型（自动识别切换）

脚本通过 CDP 探测当前打开的是哪个 Vue 组件，自动适配：

| 题型 | Vue 组件 | 做法 |
| --- | --- | --- |
| 单词朗读 | `readingLoudlyV2` | 回放标准发音 → 评分 → `nextList()` |
| 句子积累朗读 | `accentDetail` | 回放标准发音 → 评分 → `goNext()` |
| 课文朗读 | `read` | 回放整段 → 评分 → `handleNext()` |
| 看义选词 | `chooseTranslateV2` | 直接点 `answer=true` 的正确选项 |
| 单元检测 | `paperDetail` | 回放匹配的**整段模型音频** → 发音评分 + 用 System.Speech **TTS 合成答案**回放 → 关键词评分 |
| 趣味配音 | `FunDubbing` / `DubbingIndex` | 准备页自动点「开始配音」→ 逐句 TTS 回放 |

核心技巧对朗读类一致：**开始录音 → 把正确发音回放到虚拟麦克风 → App 录音窗口 → 自动切下一题**。
不同题型脚本每轮重新探测即可自适应（`detect()` 按 Vue 组件名识别）。

## 原理

西柚本质是一个包壳浏览器，作业全部在云端 `student.xiyouyingyu.com`。题型都由 Vue 组件
驱动，本项目通过 **Chrome 远程调试 (CDP)** 直接调用组件方法（例如单词题就是 `readingLoudlyV2`）。

**关键音频链路**（需要 VB-Cable 虚拟声卡）：

- 默认**麦克风** = `CABLE Output`（App 录音从这里取声音）
- 默认**播放输出** = `CABLE Input`（脚本往这里放音，会出现在 `CABLE Output`）

于是：脚本下载正确发音 → 在录音窗口内循环回放到 `CABLE Input` → App 从 `CABLE Output`


（即麦克风）录到正确发音 → 几乎满分。

## 目录结构

```
.
├── config.json                 # 配置文件（设备名/端口/路径都在这改）
├── xiyou-auto.js               # 核心自动化脚本（驱动 Vue 组件）
├── xiyou-launch.ps1            # 启动器（起客户端 + 检测作业 + 自动朗读）
├── 双击启动-西柚自动朗读.bat     # 双击运行入口
├── xiyou-driver.js             # 通用 CDP 驱动（辅助调试，可忽略）
├── audio-tool/
│   ├── audio-tool.csproj       # .NET 6 音频工具（NAudio）项目
│   ├── Xiaoyou-audio.cs        # 录制 / 回放源码
│   └── setdev/
│       ├── setdev.csproj       # 设置默认音频设备的 .NET 工具
│       └── SetAudioDevice.cs   # 改默认麦克风/播放设备（Core Audio）
└── .gitignore
```

## 首次准备（只做一次）

1. **安装 VB-Cable**：https://vb-audio.com/Cable/ ，下载 `VBCABLE_Setup_x64.exe`，
   以管理员身份运行，**安装后重启电脑**。

2. **安装 Node.js**（脚本用 `node` 运行，Windows 需要 ≥ 18，推荐 LTS）：
   - 下载：https://nodejs.org/zh-cn/download （或 https://nodejs.org/en/download/prebuilt-installer ），选
     **Windows Installer (.msi)** 的 **LTS** 版本。
   - 安装：双击 `.msi`，一路默认（会自动把 `node` 加到 PATH）。完成后**重开一个终端**再测，避免 PATH 未刷新。
   - 验证：在终端敲 `node -v`，能打印版本号（如 `v20.11.1` / `v24.19.0`）即成功。
   - 本项目脚本**只用 Node 内置模块**（`http`/`fs`/`path`/`child_process`/`WebSocket`），**无需 `npm install`**，
     所以不必装全局依赖；若上面验证通过，无需额外 `npm` 操作。

3. **安装 .NET 6 SDK**（用来编译 `audio-tool` 里的两个音频工具，仅 Windows 需要）：
   - 下载：https://dotnet.microsoft.com/download/dotnet/6.0 ，选 **Windows x64** 的 **SDK 6.0.4xx**。
     （点击右侧“所有 .NET 6.0 下载”→ 找到“SDK 6.0.xxx”→ 下载 `dotnet-sdk-6.0.xxx-win-x64.exe`。）
     > 若你的电脑已装过 SDK，可先 `dotnet --list-sdks` 确认是否已有 **6.0**；直接装 6.0 即可，装更高版本（如 8.0）也能编译本项目。
   - 安装：双击 `.exe`，默认路径一般是 `C:\Program Files\dotnet`，一路下一步。装完**重开终端**。
   - 验证：`dotnet --version` 能打印 `6.0.xxx` 即成功；`dotnet --list-sdks` 能列出 6.0.xxx。
   - 若 `dotnet` 提示找不到：确认安装时勾选了“添加到 PATH”，或手动把 `C:\Program Files\dotnet` 加入系统环境变量 `Path`，
     然后重启终端/电脑。

4. **编译音频工具**（需要 .NET 6 SDK）：
   ```bash
   cd audio-tool && dotnet build -c Release
   cd setdev && dotnet build -c Release
   ```
   产物在 `audio-tool/bin/Release/net6.0/xiaoyou-audio.exe` 和
   `audio-tool/setdev/bin/Release/net6.0/setdev.exe`。

5. 确认西柚客户端可以正常登录。
6. （可选）确认 `config.json` 里的 `clientExe` 路径指向你的客户端。

> **无需改系统的默认麦克风/扬声器，只有西柚 App 的麦克风**走虚拟声卡（`CABLE Output`），**其他软件仍用真实麦克风/扬声器，
> 不会把你其他声音录进去**。`config.json` 里 `useCableMicOverride: true` 已默认开启。

## 使用

1. **双击** `双击启动-西柚自动朗读.bat`。
   （或手动：`powershell -ExecutionPolicy Bypass -File xiyou-launch.ps1`）
2. 启动器会在后台启动西柚客户端（自动带调试端口），并进入 **watch 模式**（持续检测）。
3. 在西柚窗口里**手动点开要做的那份作业**（单词朗读 / 句子积累朗读 / 课文朗读 任一）。
4. 启动器自动识别题型并开始朗读、切下一题，直到整组完成并提交。

**可随时暂停/退出，再进入对应作业即可继续**：因为启动器是 `watch` 无限循环，它会不停探测，
你重新打开任何朗读作业（哪怕是之前做到一半的），它都会从当前题继续，无需重启程序。

### 手动运行（不经启动器）

自己先打开西柚并进入朗读练习界面，然后：

```
node xiyou-auto.js status    # 自动识别题型 + 显示当前题/进度/是否录音中
node xiyou-auto.js run 10    # 只朗读 10 题后停
node xiyou-auto.js runall    # 朗读整组作业直到提交
node xiyou-auto.js watch     # 持续循环：自动识别并朗读任何打开的朗读作业（可断点续读）
```

## 常见问题

- **提示“麦克风初始化失败”**：脚本会自动给西柚页面授予麦克风权限并注入 `getUserMedia` 覆盖。
  若仍失败，确认 VB-Cable 已装、`CABLE Output` 设备存在；必要时重启客户端。
- **某个词得分不高**：脚本用的是组件给的 `enPronunciation`/`audioURL` 权威直链，通常没问题；
  个别词发音文件很短，多听几遍即可，不影响完成。
- **`.bat` / `.ps1` 打开报“找不到文件”**：`xiyou-launch.ps1` 必须保持 **UTF-8 带 BOM**（本仓库已配好），
  `config.json` 必须是 **UTF-8 不带 BOM**（Node 的 `JSON.parse` 遇到 BOM 会报错）。重新编辑时注意区分：`.ps1` 用
  “UTF-8 with BOM”，`config.json` 用“UTF-8 without BOM”。
- **启动器没检测到作业界面 / 退出后再进不自动继续**：确认已在西柚里点开了「朗读单词 / 句子积累 /
  课文朗读」的练习界面（出现 `1/10`、`1/83` 类似进度）。启动器默认是 `watch` 模式，会持续探测，
  重新打开作业即自动续读；若用了 `run`/`runall` 且中途退出，重跑 `node xiyou-auto.js runall`
  或 `watch` 即可继续。
- **首次启动报 `WebSocket: en.word.score ... is invalid`**：这是评测引擎初始化竞态，脚本已自动
  重试等待引擎就绪（最多 5 次）；若偶发失败，重跑一次即可。
- **会不会把其他软件的声音也录进去？** 不会。脚本只让西柚 App 的麦克风用虚拟声卡（`getUserMedia`
  覆盖），其他软件仍用真实麦克风/扬声器，不影响你同时做别的事。
- **课文朗读(整段)较慢**：整段课文的录音窗口有 1~2 分钟（要录完整段），属正常；单词/句子现在
  会用“播几遍→主动停止→切下一题”，不再等满整个倒计时。

## Mac 适配（理论适配，未实测）
> 暂时不适配mac版本 ~~技术不够~~

> 本项目最初面向 Windows（西柚客户端是 `.exe`，靠 VB-Cable + .NET 音频工具回放）。
> **CDP 自动化逻辑本身是跨平台的**（只驱动浏览器，`detect()`/`chooseAnswer()`/`watch` 都能在 Mac 跑），
> 但音频输入输出、客户端路径、启动方式是平台相关。以下为**理论适配方案，未在 Mac 实测**，
> 请谨慎使用；如能提供可运行的 Mac 客户端和虚拟声卡，我可进一步适配实测。

### Mac 上的配置（改 `config.json`）

```json
{
  "port": 9222,
  "platform": "mac",
  "clientExe": "/Applications/Xiyou.app/Contents/MacOS/xiyou",  // 改成你的 mac 版西柚路径
  "cableMicDevice": "BlackHole 2ch",                            // 或 Loopback 的设备名
  "useCableMicOverride": true,
  "replayCmd": "afplay %f"                                       // 把默认输出路由进 BlackHole 回环
}
```

要点：
- 改成 `platform: "mac"` 后，`xiyou-auto.js` 仍会用 `getUserMedia` 覆盖让你的麦克风只走虚拟声卡。
- Mac 上没有 `.NET` 音频工具，用 `replayCmd` 指定回放命令（`%f` 会替换成音频文件路径）。
  BlackHole 安装后，把「默认输出」设为 BlackHole，则 `afplay` 播出的声音会进到 BlackHole 回环，
  西柚的麦克风（被覆盖到 BlackHole）就录到了；再配合把「默认输入」暂时指回真实麦克风，避免录进系统声音。
- 若 Mac 版西柚不允许 `--remote-debugging-port` 直启，可先手动开 App，再用 `xiyou-auto.js watch` 连
  现有实例（`client()` 会重试等待调试端口就绪）。

### Mac 启动脚本（可选，参考）

```bash
#!/usr/bin/env bash
# xiyou-launch.sh —— mac 版启动器（未实测）
cd "$(dirname "$0")"
echo "请在打开的西柚窗口里手动进入朗读/选词作业..."
node xiyou-auto.js watch
```

## 技术栈

- **Node.js**：CDP (Chrome DevTools Protocol) 驱动 Vue 组件，无第三方依赖。
- **.NET 6 + NAudio**：麦克风录音与回放到指定虚拟设备（仅 Windows 构建时需要）。
- **VB-Cable**：虚拟声卡回环（Windows）。Mac 用 BlackHole / Loopback。
