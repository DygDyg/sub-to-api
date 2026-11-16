using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

internal static class Updater {
  private static readonly string[] Files = {
    "sub-to-api.exe", "updater.exe", "tray.ps1", "update.ps1", "start.bat",
    "icon.ico", "README.txt", "THIRD_PARTY_NOTICES.md"
  };

  private static string logPath;

  private static int Main(string[] args) {
    Dictionary<string, List<string>> options = ParseArgs(args);
    string settings = Required(options, "--settings");
    Directory.CreateDirectory(settings);
    logPath = Path.Combine(settings, "update.log");

    try {
      int serverPid = Int32.Parse(Required(options, "--server-pid"));
      int port = Int32.Parse(Required(options, "--port"));
      string source = Path.GetFullPath(Required(options, "--source"));
      string target = Path.GetFullPath(Required(options, "--target"));
      string work = Directory.GetParent(Directory.GetParent(source).FullName).FullName;
      string backup = Path.Combine(work, "backup");
      List<string> appArgs = Values(options, "--app-arg");

      Log("update start pid=" + serverPid + " source=" + source + " target=" + target);
      if (!WaitForExit(serverPid, 30000)) {
        Log("server " + serverPid + " did not exit, stopping it");
        Kill(serverPid);
        if (!WaitForExit(serverPid, 10000)) throw new InvalidOperationException("server is still running");
      }

      Dictionary<string, bool> existed;
      try {
        existed = Backup(target, backup);
      } catch (Exception error) {
        Log("backup failed: " + error.Message);
        TryStart(target, appArgs);
        return 1;
      }
      try {
        CopyRelease(source, target);
        Log("files replaced");
      } catch (Exception error) {
        Log("copy failed: " + error.Message + "; restoring");
        Restore(target, backup, existed);
        TryStart(target, appArgs);
        return 1;
      }

      Process next = null;
      try {
        next = StartApp(target, appArgs);
      } catch (Exception error) {
        Log("start failed: " + error.Message);
      }

      if (next != null && WaitForServer(port, 25000)) {
        Log("new version is running");
        TryDeleteDirectory(backup);
        return 0;
      }

      Log("new version did not answer, rolling back");
      if (next != null) {
        try { if (!next.HasExited) next.Kill(); } catch { }
        try { next.WaitForExit(10000); } catch { }
      }
      try {
        Restore(target, backup, existed);
        StartApp(target, appArgs);
        Log("previous version restored");
      } catch (Exception error) {
        Log("rollback failed: " + error.Message);
      }
      return 1;
    } catch (Exception error) {
      Log("update failed: " + error);
      return 1;
    }
  }

  private static Dictionary<string, List<string>> ParseArgs(string[] args) {
    Dictionary<string, List<string>> result = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
    for (int i = 0; i < args.Length; i++) {
      string key = args[i];
      if (!key.StartsWith("--") || i + 1 >= args.Length) continue;
      string value = args[++i];
      if (!result.ContainsKey(key)) result[key] = new List<string>();
      result[key].Add(value);
    }
    return result;
  }

  private static string Required(Dictionary<string, List<string>> options, string name) {
    List<string> values;
    if (!options.TryGetValue(name, out values) || values.Count == 0 || String.IsNullOrWhiteSpace(values[0]))
      throw new ArgumentException("missing argument " + name);
    return values[0];
  }

  private static List<string> Values(Dictionary<string, List<string>> options, string name) {
    List<string> values;
    return options.TryGetValue(name, out values) ? values : new List<string>();
  }

  private static void Log(string message) {
    try {
      File.AppendAllText(logPath, DateTime.Now.ToString("s") + " " + message + Environment.NewLine, new UTF8Encoding(false));
    } catch { }
  }

  private static bool WaitForExit(int pid, int milliseconds) {
    try {
      Process process = Process.GetProcessById(pid);
      return process.WaitForExit(milliseconds);
    } catch (ArgumentException) {
      return true;
    }
  }

  private static void Kill(int pid) {
    try { Process.GetProcessById(pid).Kill(); } catch { }
  }

  private static Dictionary<string, bool> Backup(string target, string backup) {
    TryDeleteDirectory(backup);
    Directory.CreateDirectory(backup);
    Dictionary<string, bool> existed = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
    foreach (string name in Files) {
      string current = Path.Combine(target, name);
      bool present = File.Exists(current);
      existed[name] = present;
      if (present) CopyWithRetry(current, Path.Combine(backup, name));
    }
    return existed;
  }

  private static void CopyRelease(string source, string target) {
    Directory.CreateDirectory(target);
    foreach (string name in Files) {
      string next = Path.Combine(source, name);
      if (File.Exists(next)) CopyWithRetry(next, Path.Combine(target, name));
    }
  }

  private static void Restore(string target, string backup, Dictionary<string, bool> existed) {
    foreach (string name in Files) {
      string destination = Path.Combine(target, name);
      if (existed[name]) CopyWithRetry(Path.Combine(backup, name), destination);
      else {
        try { if (File.Exists(destination)) File.Delete(destination); } catch { }
      }
    }
  }

  private static void CopyWithRetry(string source, string destination) {
    Exception last = null;
    for (int attempt = 0; attempt < 20; attempt++) {
      try {
        File.Copy(source, destination, true);
        return;
      } catch (Exception error) {
        last = error;
        Thread.Sleep(500);
      }
    }
    throw last;
  }

  private static Process StartApp(string target, List<string> appArgs) {
    ProcessStartInfo info = new ProcessStartInfo();
    info.FileName = Path.Combine(target, "sub-to-api.exe");
    info.WorkingDirectory = target;
    info.UseShellExecute = false;
    info.Arguments = JoinArguments(appArgs);
    return Process.Start(info);
  }

  private static void TryStart(string target, List<string> appArgs) {
    try { StartApp(target, appArgs); } catch (Exception error) { Log("start failed: " + error.Message); }
  }

  private static string JoinArguments(List<string> args) {
    StringBuilder result = new StringBuilder();
    foreach (string arg in args) {
      if (result.Length > 0) result.Append(' ');
      result.Append(QuoteArgument(arg));
    }
    return result.ToString();
  }

  private static string QuoteArgument(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
    StringBuilder result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(ch);
      slashes = 0;
    }
    result.Append('\\', slashes * 2);
    result.Append('"');
    return result.ToString();
  }

  private static bool WaitForServer(int port, int milliseconds) {
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
    while (DateTime.UtcNow < deadline) {
      try {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
        request.Timeout = 2000;
        request.ReadWriteTimeout = 2000;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) { return true; }
      } catch { Thread.Sleep(700); }
    }
    return false;
  }

  private static void TryDeleteDirectory(string path) {
    try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
  }
}
