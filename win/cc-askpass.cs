// cc-askpass Windows helper: one program, its mode chosen by its name and arguments.
//   cc-askpass.exe serve <session id>   listener, started by the mod
//   cc-askpass.exe reply                copies stdin (<token>\t<id>\n<password>\n) to the listener
//   cc-askpass.exe <prompt>             askpass, started by ssh and git through SSH_ASKPASS
//   ssh.exe <ssh arguments>             the ssh wrapper (shim\ssh.exe)
// Built by win/build.ps1 with Windows PowerShell's Add-Type: C# 5 on .NET Framework 4.x.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class Program
{
    public static int Main(string[] args)
    {
        string self = System.Reflection.Assembly.GetEntryAssembly().Location;
        if (string.Equals(Path.GetFileNameWithoutExtension(self), "ssh", StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("cc-askpass: the ssh wrapper is not built yet");
            return 255;
        }
        if (args.Length == 2 && args[0] == "serve") return Listener.Run(args[1]);
        if (args.Length == 1 && args[0] == "reply") return Replier.Run();
        return Asker.Run(args.Length > 0 ? args[0] : "");
    }
}

static class Native
{
    const uint PIPE_ACCESS_DUPLEX = 0x3;
    const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x80000;
    const uint FILE_FLAG_OVERLAPPED = 0x40000000;
    const uint PIPE_REJECT_REMOTE_CLIENTS = 0x8;
    const uint PIPE_UNLIMITED_INSTANCES = 255;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint TH32CS_SNAPPROCESS = 0x2;
    const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipeW(string name, uint openMode, uint pipeMode, uint maxInstances,
        uint outBufferSize, uint inBufferSize, uint defaultTimeout, ref SECURITY_ATTRIBUTES attributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);

    // A pipe instance only the current user can open; `first` fails while any instance of the name exists.
    public static NamedPipeServerStream CreatePipe(string name, bool first)
    {
        PipeSecurity security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl,
            AccessControlType.Allow));
        byte[] descriptor = security.GetSecurityDescriptorBinaryForm();
        GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
        try
        {
            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
            attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            attributes.lpSecurityDescriptor = pinned.AddrOfPinnedObject();
            uint openMode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
            SafePipeHandle handle = CreateNamedPipeW(@"\\.\pipe\" + name, openMode, PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES, 4096, 4096, 0, ref attributes);
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            // Overlapped, so a reply can be written while the connection's thread waits in a read.
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally
        {
            pinned.Free();
        }
    }

    public static int ClientPid(NamedPipeServerStream pipe)
    {
        uint pid;
        return GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) ? (int)pid : 0;
    }

    // pid -> parent pid of every running process.
    public static Dictionary<int, int> ParentPids()
    {
        Dictionary<int, int> parents = new Dictionary<int, int>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) return parents;
        try
        {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry))
                parents[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return parents;
    }

    // The executable's full path, or null when the process cannot be opened.
    public static string ImagePath(int pid)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            StringBuilder name = new StringBuilder(32768);
            uint size = (uint)name.Capacity;
            return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString(0, (int)size) : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static string CommandLine(int pid)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            int length;
            NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
            if (length <= 0) return null;
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, length, out length) != 0)
                    return null;
                // A UNICODE_STRING: USHORT Length (bytes), USHORT MaximumLength, then the pointer, aligned.
                int bytes = Marshal.ReadInt16(buffer) & 0xFFFF;
                return Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, IntPtr.Size), bytes / 2);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }
}

static class Json
{
    public static string Str(string s)
    {
        if (s == null) return "null";
        StringBuilder json = new StringBuilder(s.Length + 2).Append('"');
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') json.Append('\\').Append(c);
            else if (c < ' ') json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }
}

// The client side of the listener's pipes, shared by askpass, reply and the ssh wrapper.
static class Pipes
{
    public static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    const int ReachMs = 5000;

    public static string Name()
    {
        return Environment.GetEnvironmentVariable("CC_ASKPASS_PIPE");
    }

    public static int NotSet()
    {
        Console.Error.WriteLine("cc-askpass: CC_ASKPASS_PIPE is not set; is the cc-askpass mod loaded in this Claude Code session?");
        return 1;
    }

    public static int Unreachable()
    {
        Console.Error.WriteLine("cc-askpass: the cc-askpass listener is not running; restart Claude Code or re-enable the mod");
        return 1;
    }

    // Null when the pipe cannot be reached in 5 s (Connect keeps retrying while it does not exist).
    public static NamedPipeClientStream Connect(string name)
    {
        NamedPipeClientStream pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut);
        try
        {
            pipe.Connect(ReachMs);
            return pipe;
        }
        catch (Exception)
        {
            pipe.Dispose();
            return null;
        }
    }

    // The bytes before the next \n. Null when the stream ends first (unless endOk) or the line exceeds max.
    public static byte[] ReadLine(Stream stream, int max, bool endOk)
    {
        MemoryStream line = new MemoryStream();
        while (true)
        {
            int b = stream.ReadByte();
            if (b == '\n' || (b < 0 && endOk)) return line.ToArray();
            if (b < 0 || line.Length >= max) return null;
            line.WriteByte((byte)b);
        }
    }

    // Sends one request line and returns the reply line, or null when the listener cannot be reached.
    // A connection that breaks first (the listener restarting) is made again and the line sent again.
    public static byte[] Request(string name, byte[] line)
    {
        while (true)
        {
            using (NamedPipeClientStream pipe = Connect(name))
            {
                if (pipe == null) return null;
                try
                {
                    pipe.Write(line, 0, line.Length);
                    byte[] reply = ReadLine(pipe, 65536, false);
                    if (reply != null) return reply;
                }
                catch (IOException)
                {
                }
            }
        }
    }

    // Tabs and line breaks become spaces; cut to max UTF-8 bytes, never inside a character.
    public static byte[] Field(string text, int max)
    {
        byte[] bytes = Utf8.GetBytes(text.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '));
        if (bytes.Length <= max) return bytes;
        int n = max;
        while (n > 0 && (bytes[n] & 0xC0) == 0x80) n--;
        Array.Resize(ref bytes, n);
        return bytes;
    }
}

static class Asker
{
    static Timer deadline;

    public static int Run(string prompt)
    {
        string name = Pipes.Name();
        if (string.IsNullOrEmpty(name)) return Pipes.NotSet();
        // Give up after 10 minutes, the Bash tool's longest timeout (a field: an unreferenced timer is collected).
        deadline = new Timer(delegate { Environment.Exit(1); }, null, 600000, Timeout.Infinite);

        byte[] field = Pipes.Field(prompt, 1000);
        byte[] line = new byte[field.Length + 1];
        field.CopyTo(line, 0);
        line[field.Length] = (byte)'\n';
        byte[] reply = Pipes.Request(name, line);
        if (reply == null) return Pipes.Unreachable();
        if (reply.Length == 0) return 1;

        // The password's bytes go out as they came, never decoded.
        using (Stream stdout = Console.OpenStandardOutput())
        {
            stdout.Write(reply, 0, reply.Length);
            stdout.WriteByte((byte)'\n');
        }
        return 0;
    }
}

static class Replier
{
    public static int Run()
    {
        string name = Pipes.Name();
        if (string.IsNullOrEmpty(name)) return Pipes.NotSet();
        using (NamedPipeClientStream pipe = Pipes.Connect(name + "-reply"))
        {
            if (pipe == null) return Pipes.Unreachable();
            // The listener still reads what was written after this end closes.
            using (Stream stdin = Console.OpenStandardInput()) stdin.CopyTo(pipe);
        }
        return 0;
    }
}

static class Listener
{
    static readonly object outLock = new object();
    static readonly Dictionary<int, NamedPipeServerStream> waiting = new Dictionary<int, NamedPipeServerStream>();
    static Stream stdout;
    static string token;
    static int lastId;
    static int claudePid;

    public static int Run(string session)
    {
        // A crash ends the listener quietly instead of opening an error dialog; the mod sees it end.
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
        {
            Console.Error.WriteLine("cc-askpass: " + e.ExceptionObject);
            Environment.Exit(1);
        };
        if (session.Length == 0 || session.IndexOf('\\') >= 0)
        {
            Console.Error.WriteLine("cc-askpass: invalid session id '" + session + "'");
            return 1;
        }
        int self = Process.GetCurrentProcess().Id;
        Native.ParentPids().TryGetValue(self, out claudePid);
        string name = "cc-askpass-" + session + "-" + claudePid;
        NamedPipeServerStream requests = CreateFirst(name);
        NamedPipeServerStream replies = requests == null ? null : CreateFirst(name + "-reply");
        if (replies == null) return 1;

        byte[] random = new byte[16];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(random);
        token = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
        // Raw bytes, not Console.Out: setting Console.OutputEncoding would change a shared console's code page.
        stdout = Console.OpenStandardOutput();
        Print("ready\t" + name + "\t" + token);

        StartThread(delegate { Accept(replies, name + "-reply", HandleReply); });
        // Nobody is left to answer once Claude Code is gone.
        StartThread(delegate
        {
            Process claude;
            try
            {
                claude = Process.GetProcessById(claudePid);
            }
            catch (ArgumentException)
            {
                Environment.Exit(0);
                return;
            }
            claude.WaitForExit();
            Environment.Exit(0);
        });
        Accept(requests, name, HandleRequest);
        return 1;
    }

    // A restart reuses the name: the old listener's instances may take a moment to close.
    static NamedPipeServerStream CreateFirst(string name)
    {
        Stopwatch clock = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                return Native.CreatePipe(name, true);
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                if (clock.ElapsedMilliseconds >= 5000)
                {
                    // The code, not Message: Windows words its messages in the user's language.
                    Console.Error.WriteLine("cc-askpass: could not create pipe " + name + " (Windows error " + error.NativeErrorCode + ")");
                    return null;
                }
                Thread.Sleep(100);
            }
        }
    }

    static void StartThread(ThreadStart body)
    {
        Thread thread = new Thread(body);
        thread.IsBackground = true;
        thread.Start();
    }

    static void Print(string line)
    {
        byte[] bytes = Pipes.Utf8.GetBytes(line + "\n");
        lock (outLock)
        {
            try
            {
                stdout.Write(bytes, 0, bytes.Length);
                stdout.Flush();
            }
            catch (IOException)
            {
                // The mod is gone.
                Environment.Exit(1);
            }
        }
    }

    // One thread per connection; the next instance exists before this one is handed off,
    // so the name is never without an instance.
    static void Accept(NamedPipeServerStream pipe, string name, Action<NamedPipeServerStream> handle)
    {
        while (true)
        {
            bool connected = true;
            try
            {
                pipe.WaitForConnection();
            }
            catch (IOException)
            {
                connected = false;
            }
            NamedPipeServerStream next;
            try
            {
                next = Native.CreatePipe(name, false);
            }
            catch (System.ComponentModel.Win32Exception error)
            {
                Console.Error.WriteLine("cc-askpass: could not create pipe " + name + " (Windows error " + error.NativeErrorCode + ")");
                Environment.Exit(1);
                return;
            }
            NamedPipeServerStream current = pipe;
            if (connected) StartThread(delegate { handle(current); });
            else current.Dispose();
            pipe = next;
        }
    }

    static void HandleRequest(NamedPipeServerStream pipe)
    {
        int id = 0;
        try
        {
            int pid = Native.ClientPid(pipe);
            byte[] line = Pipes.ReadLine(pipe, 8192, false);
            if (line == null) return;
            string described = Describe(pid, Pipes.Utf8.GetString(line).TrimEnd('\r'));
            lock (waiting)
            {
                id = ++lastId;
                waiting[id] = pipe;
            }
            Print("{\"id\":" + id + "," + described + "}");
            // The asker sends nothing more: this read ends when it closes, answered or not.
            while (pipe.ReadByte() >= 0)
            {
            }
        }
        catch (IOException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
        finally
        {
            bool gone;
            lock (waiting) gone = id != 0 && waiting.Remove(id);
            if (gone) Print("{\"gone\":" + id + "}");
            pipe.Dispose();
        }
    }

    static void HandleReply(NamedPipeServerStream pipe)
    {
        try
        {
            byte[] head = Pipes.ReadLine(pipe, 256, false);
            byte[] password = head == null ? null : Pipes.ReadLine(pipe, 65536, true);
            if (password == null) return;
            string[] fields = Pipes.Utf8.GetString(head).TrimEnd('\r').Split('\t');
            int id;
            if (fields.Length != 2 || fields[0] != token ||
                !int.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out id)) return;
            NamedPipeServerStream asker;
            lock (waiting)
            {
                if (!waiting.TryGetValue(id, out asker)) return;
                waiting.Remove(id);
            }
            byte[] message = new byte[password.Length + 1];
            password.CopyTo(message, 0);
            message[password.Length] = (byte)'\n';
            try
            {
                asker.Write(message, 0, message.Length);
            }
            catch (IOException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
        }
        catch (IOException)
        {
        }
        finally
        {
            pipe.Dispose();
        }
    }

    // The JSON fields after "id": who connected, its parent, the ancestors up to Claude Code, the request.
    static string Describe(int clientPid, string line)
    {
        Dictionary<int, int> parents = Native.ParentPids();
        StringBuilder json = new StringBuilder();
        json.Append("\"client\":{\"pid\":").Append(clientPid)
            .Append(",\"exe\":").Append(Json.Str(Native.ImagePath(clientPid) ?? "")).Append('}');

        int parentPid;
        string parentExe = parents.TryGetValue(clientPid, out parentPid) ? Native.ImagePath(parentPid) : null;
        json.Append(",\"parent\":");
        if (parentExe == null) json.Append("null");
        else
            json.Append("{\"pid\":").Append(parentPid).Append(",\"exe\":").Append(Json.Str(parentExe))
                .Append(",\"args\":").Append(Json.Str(Native.CommandLine(parentPid) ?? "")).Append('}');

        json.Append(",\"ancestors\":[");
        HashSet<int> seen = new HashSet<int>();
        int pid = parentExe == null ? 0 : parentPid;
        for (int n = 0; n < 16 && pid != 0 && pid != claudePid && seen.Add(pid); n++)
        {
            if (n > 0) json.Append(',');
            json.Append("{\"pid\":").Append(pid).Append(",\"args\":").Append(Json.Str(Native.CommandLine(pid) ?? ""))
                .Append('}');
            if (!parents.TryGetValue(pid, out pid)) break;
        }
        json.Append(']');

        // relay<TAB><host><TAB><real ssh><TAB><remote pid><TAB><prompt><TAB><via><TAB><reported>
        string[] fields = line.Split('\t');
        int remotePid;
        if (fields.Length == 7 && fields[0] == "relay" &&
            int.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out remotePid))
        {
            json.Append(",\"prompt\":").Append(Json.Str(fields[4]))
                .Append(",\"relay\":{\"host\":").Append(Json.Str(fields[1]))
                .Append(",\"realSsh\":").Append(Json.Str(fields[2]))
                .Append(",\"remotePid\":").Append(remotePid)
                .Append(",\"via\":").Append(Json.Str(fields[5].Length == 0 ? null : fields[5]))
                .Append(",\"reported\":").Append(Json.Str(fields[6].Length == 0 ? null : fields[6]))
                .Append('}');
        }
        else json.Append(",\"prompt\":").Append(Json.Str(line)).Append(",\"relay\":null");
        return json.ToString();
    }
}
