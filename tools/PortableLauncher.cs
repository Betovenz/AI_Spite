using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

internal static class PortableLauncher
{
    private const int FirstPort = 24242;
    private const int PortCount = 10;

    private static int Main()
    {
        Console.Title = "BlueSPite";

        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "runtime", "node.exe");
        string server = Path.Combine(root, "app", "server", "server.mjs");
        string data = Path.Combine(root, "data");
        string media = Path.Combine(root, "Generated Media");

        if (!File.Exists(node) || !File.Exists(server))
        {
            Console.Error.WriteLine("[BlueSPite] Portable files are incomplete.");
            Console.Error.WriteLine("Extract the whole ZIP and keep runtime/app beside BlueSPite.exe.");
            Console.WriteLine("Press any key to close...");
            Console.ReadKey(true);
            return 1;
        }

        Directory.CreateDirectory(data);
        Directory.CreateDirectory(media);

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = node;
        start.Arguments = "\"" + server + "\"";
        start.WorkingDirectory = Path.Combine(root, "app");
        start.UseShellExecute = false;
        start.CreateNoWindow = false;
        start.EnvironmentVariables["BLUESPITE_DATA_DIR"] = data;
        start.EnvironmentVariables["BLUESPITE_MEDIA_DIR"] = media;

        try
        {
            using (Process child = Process.Start(start))
            {
                int port = WaitForBlueSPite(child);
                if (port > 0)
                {
                    OpenBrowser("http://127.0.0.1:" + port + "/");
                }

                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[BlueSPite] Could not start: " + error.Message);
            Console.WriteLine("Press any key to close...");
            Console.ReadKey(true);
            return 1;
        }
    }

    private static int WaitForBlueSPite(Process child)
    {
        for (int attempt = 0; attempt < 80; attempt++)
        {
            if (child.HasExited) return -1;

            for (int port = FirstPort; port < FirstPort + PortCount; port++)
            {
                if (IsBlueSPite(port)) return port;
            }

            Thread.Sleep(200);
        }

        Console.Error.WriteLine("[BlueSPite] Server started, but the web page was not detected.");
        Console.Error.WriteLine("Open http://127.0.0.1:24242/ in Chrome.");
        return -1;
    }

    private static bool IsBlueSPite(int port)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
            request.Timeout = 250;
            request.ReadWriteTimeout = 250;
            request.Proxy = null;

            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                string body = reader.ReadToEnd();
                return body.IndexOf("BlueSPite", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch
        {
            return false;
        }
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            ProcessStartInfo open = new ProcessStartInfo();
            open.FileName = url;
            open.UseShellExecute = true;
            Process.Start(open);
        }
        catch
        {
            Console.WriteLine("Open this address in Chrome: " + url);
        }
    }
}
