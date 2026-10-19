# Marketplace 发布

## 当前身份

| 项目 | 值 |
| --- | --- |
| 发布者 ID | `LimeLisest` |
| 扩展名称 | `limelisest-napcat-qq` |
| 完整标识 | `LimeLisest.limelisest-napcat-qq` |
| 展示名称 | OneBot QQ · Native Chat |
| 商店图标 | `media/icon.png`，256×256 PNG |

GitHub 账号与 Marketplace 发布者分别管理。需要先用微软账号登录 [发布者管理页](https://marketplace.visualstudio.com/manage)，创建或取得 `LimeLisest` 发布者的权限。代码里的 `publisher` 字段不会创建商店账号。

## 构建安装包

明确发布正式版本时，在项目根目录执行：

```sh
npm ci
npm run version:release
npm run build
npm test
npm run test:extension
npm run package -- --release
```

安装包输出到 `artifacts/limelisest-napcat-qq-<version>.vsix`，版本号以 `package.json` 为准。README、预览 PNG、更新日志、支持说明和许可会一起打包；本地配置、测试产物及源码工具不会进入安装包。

首次发布前，在扩展开发窗口验证连接、文字、图片、表情、回复和文件操作。测试脚本只连接模拟 NapCat，不发送真实 QQ 消息。

## 手动上传

1. 打开发布者管理页，选择 `LimeLisest`。
2. 首次上传选择 **New extension → Visual Studio Code**。
3. 上传刚生成的 VSIX，检查展示名称、图标和说明后提交。
4. 等待平台验证完成，在管理页检查发布状态。

## 开发版本编号

开发版本使用下一正式版本加 `-devN`，例如：

```text
0.2.18 → 0.2.19-dev1 → 0.2.19-dev2 → 0.2.19
0.2.19 → 0.2.20-dev1 → 0.2.20-dev2 → 0.2.20
```

- `npm run version:dev`：从正式版开始下一补丁版本的 `dev1`；已有开发版则只增加开发号，`dev9` 后为 `dev10`。
- `npm run package`：按当前版本打包，如 `artifacts/limelisest-napcat-qq-0.2.19-dev1.vsix`，带 VS Code 预发行标记。构建和打包不会自动改号。
- `node scripts/install-extension.cjs`：安装当前开发包，并核对安装后的实际版本。

明确要求正式发版时，执行 `npm run version:release`，例如将 `0.2.19-dev3` 转为 `0.2.19`，同步整理 `CHANGELOG.md`，再构建并执行 `npm run package -- --release`。正式包安装使用 `node scripts/install-extension.cjs --release`。

版本命令同步更新 `package.json` 和 `package-lock.json`。后续更新保留同一发布者与扩展名称，在已有扩展中上传正式版本。开发版仅用于本地 VSIX 分发；[Marketplace 目前不支持 SemVer 开发后缀](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#pre-release-extensions)，商店包使用去掉 `-devN` 后的正式版本。

官方流程见 [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。

## 自制图标与预览

`media/icon.svg` 是本项目自制的消息气泡与代码符号图形。`npm run screenshots` 在独立测试窗口中将它渲染成 256×256 PNG，并重拍四张 1600×1000 的 UI 预览。检查 `.test-output/previews/` 后，将图片复制到 `docs/images/`，再打包。

商店清单使用 PNG 图标；侧栏和聊天标签保留适合 VS Code 主题的 SVG 图标。不使用 QQ 企鹅、官方商标图形或从 QQ 客户端提取的图标。
