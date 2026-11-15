using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher {
  [STAThread]
  private static void Main() {
    string directory = AppDomain.CurrentDomain.BaseDirectory;
    string script = Path.Combine(directory, "start.bat");
    if (!File.Exists(script)) {
      MessageBox.Show("Не найден start.bat рядом с программой.", "SubToAPI", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return;
    }
    Process.Start(new ProcessStartInfo {
      FileName = script,
      WorkingDirectory = directory,
      UseShellExecute = true,
      WindowStyle = ProcessWindowStyle.Minimized,
    });
  }
}
