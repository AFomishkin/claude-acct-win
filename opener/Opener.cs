// Link handler for $BROWSER. Claude Code runs it as `opener.exe <url>`:
// claude-acct.localhost links go to `claude-acct open-url`, every other link goes
// where it would have gone without us (the default browser or the previous $BROWSER).
//
// Built with the stock csc.exe from .NET Framework, /target:winexe, so no console
// window flashes. opener.conf sits next to the exe (node=..., cli=..., browser=...).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;

internal static class Opener
{
    private const string Ours = "http://claude-acct.localhost/";

    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            return 0;
        }
        string url = args[0];
        Dictionary<string, string> conf = ReadConf();
        try
        {
            if (url.StartsWith(Ours, StringComparison.OrdinalIgnoreCase))
            {
                return RunCli(conf, url);
            }
            return OpenElsewhere(conf, url);
        }
        catch (Exception e)
        {
            Log(conf, "error: " + e.Message);
            return 1;
        }
    }

    private static string Dir()
    {
        return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    }

    private static Dictionary<string, string> ReadConf()
    {
        var conf = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string file = Path.Combine(Dir(), "opener.conf");
        if (!File.Exists(file))
        {
            return conf;
        }
        foreach (string raw in File.ReadAllLines(file))
        {
            string line = raw.Trim();
            int eq = line.IndexOf('=');
            if (line.Length == 0 || line.StartsWith("#") || eq <= 0)
            {
                continue;
            }
            conf[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
        }
        return conf;
    }

    private static string Get(Dictionary<string, string> conf, string key)
    {
        string value;
        return conf.TryGetValue(key, out value) ? value : "";
    }

    // Wait for it to exit: if the parent goes away first, the switch may not get
    // to finish — the process doing it was started by us.
    private static int RunCli(Dictionary<string, string> conf, string url)
    {
        string node = Get(conf, "node");
        string cli = Get(conf, "cli");
        if (node.Length == 0 || cli.Length == 0)
        {
            Log(conf, "opener.conf has no node/cli: " + url);
            return 1;
        }
        if (url.IndexOf('"') >= 0)
        {
            Log(conf, "the link contains a quote, refusing: " + url);
            return 1;
        }
        // The working directory is the temp dir, not the app dir: otherwise the process
        // holds it, and a claude-acct upgrade fails on the rename.
        var info = new ProcessStartInfo(node, "\"" + cli + "\" open-url \"" + url + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetTempPath(),
        };
        using (Process child = Process.Start(info))
        {
            if (child == null)
            {
                return 1;
            }
            if (!child.WaitForExit(30000))
            {
                return 0; // no point waiting longer; the work carries on by itself
            }
            return child.ExitCode;
        }
    }

    private static int OpenElsewhere(Dictionary<string, string> conf, string url)
    {
        string browser = Get(conf, "browser");
        if (browser.Length > 0)
        {
            var info = new ProcessStartInfo(browser, "\"" + url + "\"") { UseShellExecute = false, CreateNoWindow = true };
            Process.Start(info);
            return 0;
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        return 0;
    }

    private static void Log(Dictionary<string, string> conf, string message)
    {
        try
        {
            File.AppendAllText(Path.Combine(Dir(), "opener.log"), DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
        }
        catch
        {
            // the log is not essential
        }
    }
}
