using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    public static readonly string DataFolder = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SJTU-LaTeX-Migration");
    private const string Payload = "SJTULaTeX.Runtime.zip";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            try
            {
                using (Process test = Process.Start(Node(ExtractRuntime(), "desktop-self-test.mjs")))
                {
                    test.WaitForExit();
                    return test.ExitCode;
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MigrationWindow());
        return 0;
    }

    public static string ExtractRuntime()
    {
        Assembly assembly = Assembly.GetExecutingAssembly();
        string digest;
        using (Stream resource = assembly.GetManifestResourceStream(Payload))
        using (SHA256 sha = SHA256.Create())
            digest = BitConverter.ToString(sha.ComputeHash(resource)).Replace("-", "").Substring(0, 24);

        string cache = Path.Combine(DataFolder, "desktop-runtime");
        Directory.CreateDirectory(cache);
        string runtime = Path.Combine(cache, digest);
        if (Directory.Exists(runtime)) return runtime;

        string temporary = Path.Combine(cache, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        try
        {
            using (Stream resource = assembly.GetManifestResourceStream(Payload))
            using (ZipArchive archive = new ZipArchive(resource, ZipArchiveMode.Read))
                archive.ExtractToDirectory(temporary);
            try { Directory.Move(temporary, runtime); }
            catch (IOException) { if (!Directory.Exists(runtime)) throw; }
        }
        finally
        {
            if (Directory.Exists(temporary)) Directory.Delete(temporary, true);
        }
        return runtime;
    }

    private static string Quote(string value)
    {
        return "\"" + Regex.Replace(value, @"(\\*)""|(\\+)$", match => match.Groups[1].Success
            ? new string('\\', match.Groups[1].Length * 2 + 1) + "\""
            : new string('\\', match.Length * 2)) + "\"";
    }

    public static ProcessStartInfo Node(string runtime, params string[] arguments)
    {
        var quoted = new List<string>();
        foreach (string argument in arguments) quoted.Add(Quote(argument));
        return new ProcessStartInfo(Path.Combine(runtime, "node.exe"), String.Join(" ", quoted))
        {
            WorkingDirectory = runtime,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
    }
}

internal sealed class MigrationWindow : Form
{
    private const string EventPrefix = "@@SJTU_UI@@";
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly CheckedListBox projects = new CheckedListBox { CheckOnClick = true, Dock = DockStyle.Fill, IntegralHeight = false };
    private readonly TextBox output = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BackColor = Color.White };
    private readonly Label status = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
    private readonly Button start = new Button { Text = "读取项目", AutoSize = true };
    private readonly Button selectAll = new Button { Text = "全选", AutoSize = true, Enabled = false };
    private readonly Button selectNone = new Button { Text = "清空选择", AutoSize = true, Enabled = false };
    private readonly Button browse = new Button { Text = "选择 ZIP 目录…", AutoSize = true };
    private readonly Button clear = new Button { Text = "清除目录", AutoSize = true, Enabled = false };
    private readonly Button stop = new Button { Text = "停止", AutoSize = true, Enabled = false };
    private readonly Button openData = new Button { Text = "打开备份目录", AutoSize = true };
    private readonly Label backup = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
    private readonly CheckBox retry = new CheckBox { Text = "重试上次未确认的上传", AutoSize = true, Margin = new Padding(0, 6, 0, 4) };
    private Process child;
    private string zipFolder;
    private string awaiting;
    private bool busy;
    private bool stopRequested;
    private bool closeAfterStop;

    public MigrationWindow()
    {
        Text = "交大 LaTeX 项目迁移";
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(780, 680);
        MinimumSize = new Size(675, 590);
        Font = new Font("Microsoft YaHei UI", 10);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(249, 250, 252);
        ForeColor = Color.FromArgb(27, 36, 48);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 10, Padding = new Padding(20, 12, 20, 12) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        foreach (int height in new[] { 46, 30, 39, 36, 30 }) layout.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 55));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 45));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        Controls.Add(layout);

        var title = Heading("交大 LaTeX 项目迁移");
        title.Font = new Font(Font.FontFamily, 19, FontStyle.Bold);
        layout.Controls.Add(title, 0, 0);
        layout.Controls.Add(Heading("latex.sjtu.edu.cn  →  latexpro.sjtu.edu.cn"), 0, 1);
        var backupRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        backupRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        backupRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        backupRow.Controls.Add(Buttons(browse, clear), 0, 0);
        backupRow.Controls.Add(backup, 1, 0);
        layout.Controls.Add(backupRow, 0, 2);
        layout.Controls.Add(retry, 0, 3);
        layout.Controls.Add(Buttons(Heading("旧站项目"), selectAll, selectNone), 0, 4);
        layout.Controls.Add(projects, 0, 5);
        layout.Controls.Add(Heading("迁移记录"), 0, 6);
        layout.Controls.Add(output, 0, 7);
        layout.Controls.Add(status, 0, 8);
        start.BackColor = Color.FromArgb(145, 31, 48);
        start.ForeColor = Color.White;
        start.FlatStyle = FlatStyle.Flat;
        start.MinimumSize = new Size(125, 32);
        layout.Controls.Add(Buttons(start, stop, openData), 0, 9);
        AcceptButton = start;

        browse.Click += delegate { PickFolder(); };
        clear.Click += delegate { zipFolder = null; UpdateControls(); };
        retry.Click += delegate {
            if (retry.Checked && MessageBox.Show(this, "请先在新站确认没有对应项目，再重试上次未确认的上传。", Text,
                MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) retry.Checked = false;
        };
        start.Click += async delegate { await Advance(); };
        selectAll.Click += delegate { CheckProjects(true); };
        selectNone.Click += delegate { CheckProjects(false); };
        stop.Click += delegate { RequestStop(); };
        openData.Click += delegate {
            try
            {
                Directory.CreateDirectory(Program.DataFolder);
                Process.Start(new ProcessStartInfo(Program.DataFolder) { UseShellExecute = true });
            }
            catch (Exception error) { Append(error.Message); }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (!busy || args.CloseReason == CloseReason.WindowsShutDown) return;
            args.Cancel = true;
            if (RequestStop()) closeAfterStop = true;
        };
        status.Text = "先读取旧站项目，再选择要迁移的项目。";
        UpdateControls();
    }

    private static Label Heading(string text)
    {
        return new Label { Text = text, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(2, 4, 8, 3) };
    }

    private static FlowLayoutPanel Buttons(params Control[] controls)
    {
        var row = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, AutoSize = true, Margin = Padding.Empty };
        row.Controls.AddRange(controls);
        return row;
    }

    private void UpdateControls()
    {
        start.Enabled = !busy || (!stopRequested && awaiting != null);
        start.Text = awaiting == "login" ? "登录完成" : awaiting == "projects" ? "迁移所选项目" : "读取项目";
        projects.Enabled = !stopRequested && awaiting == "projects";
        selectAll.Enabled = selectNone.Enabled = projects.Enabled;
        browse.Enabled = retry.Enabled = !busy;
        clear.Enabled = !busy && zipFolder != null;
        stop.Enabled = busy && !stopRequested;
        backup.Text = zipFolder ?? "从旧站下载项目 ZIP";
    }

    private void PickFolder()
    {
        using (var dialog = new FolderBrowserDialog { Description = "选择包含各个项目 ZIP 的文件夹", ShowNewFolderButton = false })
        {
            if (zipFolder != null) dialog.SelectedPath = zipFolder;
            if (dialog.ShowDialog(this) == DialogResult.OK) zipFolder = dialog.SelectedPath;
        }
        UpdateControls();
    }

    private void CheckProjects(bool value)
    {
        for (int index = 0; index < projects.Items.Count; index++) projects.SetItemChecked(index, value);
    }

    private void Append(string line)
    {
        output.AppendText(line + Environment.NewLine);
    }

    private void HandleLine(string line)
    {
        if (!line.StartsWith(EventPrefix, StringComparison.Ordinal)) { Append(line); return; }
        if (stopRequested) return;
        var message = json.Deserialize<Dictionary<string, object>>(line.Substring(EventPrefix.Length));
        awaiting = (string)message["kind"];
        if (awaiting == "login")
        {
            status.Text = (string)message["message"];
            Append(status.Text);
        }
        else if (awaiting == "projects")
        {
            projects.Items.Clear();
            foreach (object name in (IEnumerable)message["names"]) projects.Items.Add((string)name, true);
            status.Text = "核对勾选项。点击「迁移所选项目」后，脚本会把这些项目上传到新站。";
            Activate();
        }
        UpdateControls();
    }

    private void Send(object value)
    {
        try
        {
            if (child != null && !child.HasExited)
            {
                child.StandardInput.WriteLine(json.Serialize(value));
                child.StandardInput.Flush();
            }
        }
        catch (IOException) { Append("迁移进程已结束。"); }
        catch (InvalidOperationException) { Append("迁移进程已结束。"); }
    }

    private bool RequestStop()
    {
        if (stopRequested) return true;
        if (MessageBox.Show(this, "停止本次迁移？已保存的结果可以在下次运行时继续使用。", Text,
            MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return false;
        stopRequested = true;
        status.Text = "正在停止…";
        Send(new { cancel = true });
        UpdateControls();
        return true;
    }

    private async Task Advance()
    {
        if (busy)
        {
            if (awaiting == "projects")
            {
                var indices = new List<int>();
                foreach (int index in projects.CheckedIndices) indices.Add(index);
                if (indices.Count == 0) { status.Text = "请至少勾选一个项目。"; return; }
                Send(new { reply = indices });
            }
            else if (awaiting == "login") Send(new { reply = true });
            awaiting = null;
            status.Text = "正在处理，请查看迁移记录。";
            UpdateControls();
            return;
        }

        busy = true;
        stopRequested = false;
        projects.Items.Clear();
        output.Clear();
        status.Text = "正在后台连接新旧站点…";
        UpdateControls();
        try
        {
            string runtime = await Task.Run(() => Program.ExtractRuntime());
            if (stopRequested) { status.Text = "已停止。"; return; }
            var arguments = new List<string> { "migrate.mjs", "--gui" };
            if (zipFolder != null) { arguments.Add("--zip-dir"); arguments.Add(zipFolder); }
            if (retry.Checked) arguments.Add("--retry-pending");
            ProcessStartInfo info = Program.Node(runtime, arguments.ToArray());
            info.RedirectStandardInput = info.RedirectStandardOutput = info.RedirectStandardError = true;
            info.StandardOutputEncoding = info.StandardErrorEncoding = Encoding.UTF8;
            using (var process = new Process { StartInfo = info })
            {
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) {
                    if (args.Data != null) BeginInvoke((Action)(() => HandleLine(args.Data)));
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) {
                    if (args.Data != null) BeginInvoke((Action)(() => Append(args.Data)));
                };
                process.Start();
                child = process;
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                await Task.Run(() => process.WaitForExit());
                status.Text = stopRequested ? "已停止。" : process.ExitCode == 0 ? "处理完成。" : "有项目未完成，请查看迁移记录。";
                child = null;
            }
        }
        catch (Exception error)
        {
            Append(error.Message);
            status.Text = "无法完成本次迁移，请查看迁移记录。";
        }
        finally
        {
            child = null;
            busy = false;
            awaiting = null;
            UpdateControls();
            if (closeAfterStop) Close();
        }
    }
}
