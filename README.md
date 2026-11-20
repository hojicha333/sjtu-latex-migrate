# 交大 LaTeX 项目迁移工具

用 Microsoft Edge 把 `latex.sjtu.edu.cn` 的自有项目逐个导入 `latexpro.sjtu.edu.cn`。脚本使用两站网页的 ZIP 下载和上传入口，适用于 2026 年 11 月版本过渡期。校方公告说明，官方自助工具发布后，两站域名将调整。[水源迁移公告](https://shuiyuan.sjtu.edu.cn/t/topic/534965)

## Windows 图形版

1. 在装有 Microsoft Edge 的 64 位 Windows 10 或 11 上，[下载 Windows EXE](https://github.com/hojicha333/sjtu-latex-migrate/releases/download/v1.0.0/SJTU-LaTeX-Migration-win-x64.exe) 并双击打开。EXE 已内置 Node.js 和 Playwright，使用电脑上已有的 Edge，无需安装浏览器扩展。
2. 如已有旧站备份，先点「选择 ZIP 目录」，选中包含各个项目 ZIP 的文件夹。否则直接点「读取项目」。
3. 如果工具弹出 Edge，请用同一个交大账号登录所提示的站点。看到项目列表后，回到迁移窗口点「登录完成」。两站登录有效后，工具会自动关闭弹出的 Edge 窗口。
4. 勾选项目后点「迁移所选项目」。下载和上传均在后台运行，可在「迁移记录」查看结果，或点「打开备份目录」查看本机备份。

旧站可勾选「全选」并点击「下载」，取回一个包含多个项目 ZIP 的总包。只解压总包一层，每个项目 ZIP 的文件名需保留原项目名，如 `我的论文.zip`。

Edge 登录会话、项目 ZIP 和迁移记录保存在本机 `%LOCALAPPDATA%\SJTU-LaTeX-Migration`。映射文件为 `migration.json`，备份位于 `zips` 子目录。「停止」后可再次运行，工具会复核已导入的项目。新站已有同名项目时会跳过，供人工核对。如果上次上传状态未确认，先在新站核对，再勾选「重试上次未确认的上传」。

## 命令行版

源码提供 `Start-Migration.cmd`。命令行版需要安装 Node.js 20+，首次运行时会下载 Playwright。

```powershell
.\Start-Migration.cmd --list
.\Start-Migration.cmd --project "我的论文" --project "实验报告"
.\Start-Migration.cmd --zip-dir "D:\LaTeX备份"
```

用 `--retry-pending` 重试结果未确认的上传，或者用 `--data-dir` 给不同账号指定独立的数据目录。

## 迁移范围

ZIP 会带上项目源文件和附件。编辑历史、协作邀请与编译设置需分别处理。首次在新站编译失败时，可在项目设置中选择原项目的编译器和 TeX Live 版本。默认批处理范围为旧站「您的项目」列表，归档、共享和回收站中的项目应按各自权限在网页上核对处理。

## 构建 EXE

在 Windows x64 上安装 Node.js 20+ 后，在 PowerShell 运行 `./desktop/Build.ps1`。构建会打包 Node.js、锁定版本的 Playwright 和迁移代码，输出到 `dist/`。可用以下命令运行本地模拟测试。

```powershell
$test = Start-Process .\dist\SJTU-LaTeX-Migration-win-x64.exe -ArgumentList '--self-test' -Wait -PassThru
$test.ExitCode
```
