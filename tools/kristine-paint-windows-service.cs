// Windows-Dienst-Host für die lokale Restfarben-Bridge.
// Kompiliert der Installer am Misch-PC mit .NET Framework; keine Fremdbinaries.
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Threading;

public sealed class KristinePaintBridgeService : ServiceBase
{
    private readonly object gate = new object();
    private Process child;
    private Timer monitor;
    private bool stopping;

    public KristinePaintBridgeService()
    {
        ServiceName = "KRISTINEPaintBridge";
        CanStop = true;
        AutoLog = false;
    }

    private static string DirectoryPath
    {
        get { return AppDomain.CurrentDomain.BaseDirectory; }
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(Path.Combine(DirectoryPath, "service.log"),
                DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
        }
        catch { }
    }

    private static string Quote(string text)
    {
        return "\"" + text.Replace("\"", "") + "\"";
    }

    private Process LaunchBridge()
    {
        string script = Path.Combine(DirectoryPath, "kristine-paint-local-bridge.ps1");
        string config = Path.Combine(DirectoryPath, "service.args");
        if (!File.Exists(script)) throw new FileNotFoundException("Bridge-Skript fehlt", script);
        if (!File.Exists(config)) throw new FileNotFoundException("Bridge-Konfiguration fehlt", config);
        string[] settings = File.ReadAllLines(config);
        if (settings.Length != 3) throw new InvalidDataException("service.args muss drei Zeilen enthalten");

        int port;
        if (!int.TryParse(settings[1], out port) || port < 1024 || port > 65535)
            throw new InvalidDataException("Bridge-Port ungültig");

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            @"System32\WindowsPowerShell\v1.0\powershell.exe");
        start.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden" +
            " -File " + Quote(script) +
            " -ScalePort " + Quote(settings[0]) +
            " -ListenPort " + port +
            " -PrinterName " + Quote(settings[2]);
        start.WorkingDirectory = DirectoryPath;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process process = Process.Start(start);
        if (process == null) throw new InvalidOperationException("PowerShell konnte nicht gestartet werden");
        Log("Bridge gestartet, PID " + process.Id);
        return process;
    }

    protected override void OnStart(string[] args)
    {
        lock (gate)
        {
            stopping = false;
            child = LaunchBridge();
            monitor = new Timer(CheckChild, null, 5000, 5000);
        }
    }

    private void CheckChild(object ignored)
    {
        lock (gate)
        {
            if (stopping) return;
            try
            {
                if (child != null && !child.HasExited) return;
                int code = child == null ? -1 : child.ExitCode;
                if (child != null) child.Dispose();
                Log("Bridge beendet (Exit " + code + "), Neustart");
                child = LaunchBridge();
            }
            catch (Exception ex)
            {
                Log("Bridge-Neustart fehlgeschlagen: " + ex.Message);
            }
        }
    }

    protected override void OnStop()
    {
        lock (gate)
        {
            stopping = true;
            if (monitor != null) { monitor.Dispose(); monitor = null; }
            if (child != null)
            {
                try
                {
                    if (!child.HasExited)
                    {
                        child.Kill();
                        child.WaitForExit(3000);
                    }
                }
                catch (Exception ex) { Log("Stop: " + ex.Message); }
                finally { child.Dispose(); child = null; }
            }
            Log("Dienst beendet");
        }
    }

    public static void Main()
    {
        ServiceBase.Run(new KristinePaintBridgeService());
    }
}
