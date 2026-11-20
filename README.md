# 交大 LaTeX 项目迁移脚本

用 Microsoft Edge 把 `latex.sjtu.edu.cn` 的自有项目逐个导入 `latexpro.sjtu.edu.cn`。脚本使用两站网页的 ZIP 下载和上传入口，适用于 2026 年 11 月版本过渡期。校方公告说明，官方自助工具发布后，两站域名将调整。[水源迁移公告](https://shuiyuan.sjtu.edu.cn/t/topic/534965)

## 开始迁移

1. 在装有 Microsoft Edge 和 Node.js 20 或更新版本的 Windows 电脑上，把工具压缩包解压到一个文件夹。首次运行需要联网下载 Playwright；使用已安装的 Edge。
2. 双击 `Start-Migration.cmd`。按窗口提示，在工具打开的 Edge 中自行完成两个站点的 jAccount 登录。用同一个交大账号，并按提示返回命令行按 Enter。
3. 核对项目列表后输入 `y`。脚本会逐个下载和导入，在终端显示结果。成功后可在新站项目列表打开项目。

Edge 登录会话、项目 ZIP 和旧项目到新项目的映射保存在本机 `%LOCALAPPDATA%\SJTU-LaTeX-Migration`。映射文件名为 `migration.json`，每个项目的 ZIP 按旧项目 ID 存在 `zips` 子目录。分发时分享工具压缩包即可。

## 只迁移部分项目或使用已有备份

```powershell
.\Start-Migration.cmd --list
.\Start-Migration.cmd --project "我的论文" --project "实验报告"
.\Start-Migration.cmd --zip-dir "D:\LaTeX备份"
```

旧站项目列表勾选「全选」后会出现「下载」，可取回一个包含多个项目 ZIP 的总包。只解压总包一层，在 `--zip-dir` 指定包含独立 ZIP 的目录。文件名须与旧站项目名一致，如 `我的论文.zip`。工具仍会凭旧站项目列表核对名称，并跳过新站已有的同名项目。

## 中断后继续

重新运行原命令即可。脚本按新站项目 ID 复核已记录的项目，并跳过同名项目供人工核对。如果项目显示「上次上传结果未确认」，先检查新站列表，确认没有对应项目后，可以用 `--retry-pending` 重试。`--data-dir` 可指定独立的数据目录，适合不同账号分别运行。

ZIP 会带上项目源文件和附件。编辑历史、协作邀请与编译设置需分别处理。首次在新站编译失败时，可在项目设置中选择原项目的编译器和 TeX Live 版本。默认批处理范围为旧站「您的项目」列表，归档、共享和回收站中的项目应按各自权限在网页上核对处理。
