// Link handler for $BROWSER. Claude Code runs it as `opener.exe <url>`:
// claude-acct.localhost links go to `claude-acct open-url`, the sign-in link that
// /login opens goes to the clipboard, every other link goes where it would have gone
// without us (the default browser or the previous $BROWSER).
//
// Built with the stock csc.exe from .NET Framework, /target:winexe, so no console
// window flashes. opener.conf sits next to the exe (node=..., cli=..., browser=...).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class Opener
{
    private const string Ours = "http://claude-acct.localhost/";

    // Where Claude Code signs in: claude.com and platform.claude.com, in older
    // versions claude.ai and console.anthropic.com.
    private static readonly string[] SignInHosts = { "claude.com", "platform.claude.com", "claude.ai", "console.anthropic.com" };

    [STAThread] // the clipboard needs it
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
            if (IsSignInLink(url))
            {
                return CopyToClipboard(url);
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

    // The link /login opens by itself: its sign-in returns to Claude Code's listener on
    // localhost. The default browser is usually signed in to some other account, so the
    // link goes to the clipboard: pasted into any browser or profile on this machine, it
    // still finishes the sign-in by itself. The link /login prints returns to
    // platform.claude.com with a code to paste back; that one is not caught, so clicking
    // it still opens the browser. Neither are the sign-in links of MCP servers.
    internal static bool IsSignInLink(string url)
    {
        Uri uri;
        if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }
        if (Array.IndexOf(SignInHosts, uri.Host) < 0 || !uri.AbsolutePath.EndsWith("/oauth/authorize", StringComparison.Ordinal))
        {
            return false;
        }
        Uri redirect;
        string value = QueryValue(uri, "redirect_uri");
        return value != null
            && Uri.TryCreate(value, UriKind.Absolute, out redirect)
            && redirect.Scheme == Uri.UriSchemeHttp
            && redirect.IsLoopback;
    }

    private static string QueryValue(Uri uri, string name)
    {
        foreach (string pair in uri.Query.TrimStart('?').Split('&'))
        {
            int eq = pair.IndexOf('=');
            if (eq > 0 && Uri.UnescapeDataString(pair.Substring(0, eq)) == name)
            {
                return Uri.UnescapeDataString(pair.Substring(eq + 1).Replace('+', ' '));
            }
        }
        return null;
    }

    // copy: true keeps the link on the clipboard after we exit; the retries wait out
    // a clipboard manager or another app that holds the clipboard for a moment.
    private static int CopyToClipboard(string url)
    {
        Clipboard.SetDataObject(url, true, 10, 100);
        return 0;
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
