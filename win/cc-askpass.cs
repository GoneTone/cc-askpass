// cc-askpass Windows helper: one program, its mode chosen by its name and arguments.
//   cc-askpass.exe serve <session id>   listener, started by the mod
//   cc-askpass.exe --reply              copies stdin (<token>\t<id>\n<password>\n) to the listener
//   cc-askpass.exe <prompt>             askpass, started by ssh and git through SSH_ASKPASS
//   ssh.exe <ssh arguments>             the ssh wrapper (shim\ssh.exe)
// Built by win/build.ps1 with Windows PowerShell's Add-Type: C# 5 on .NET Framework 4.x.
using System;
using System.Collections.Concurrent;
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
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class Program
{
    public static int Main(string[] args)
    {
        // UTF-8, as stdout: the console's code page cannot carry every path or message, and setting
        // Console.OutputEncoding would change a shared console's code page.
        StreamWriter stderr = new StreamWriter(Console.OpenStandardError(), Pipes.Utf8);
        stderr.AutoFlush = true;
        Console.SetError(stderr);
        string self = System.Reflection.Assembly.GetEntryAssembly().Location;
        if (string.Equals(Path.GetFileNameWithoutExtension(self), "ssh", StringComparison.OrdinalIgnoreCase))
            return SshWrapper.Run(self, args);
        if (args.Length == 2 && args[0] == "serve") return Listener.Run(args[1]);
        // A server chooses the prompt ssh passes to askpass, so the mode is an option, not a plain word.
        if (args.Length == 1 && args[0] == "--reply") return Replier.Run();
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

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        // JOBOBJECT_BASIC_LIMIT_INFORMATION
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
        // IO_COUNTERS
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,
        int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    static IntPtr killOnCloseJob;

    // Puts this process into a job whose processes all end when its last handle closes, so every
    // child is born inside it. The handle is never closed here (it goes with this process) and is
    // not inheritable, so no child keeps the job alive. False (Windows error in error) on failure.
    public static bool EnterKillOnCloseJob(out int error)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        bool ok = job != IntPtr.Zero &&
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info)) &&
            AssignProcessToJobObject(job, GetCurrentProcess());
        error = ok ? 0 : Marshal.GetLastWin32Error();
        if (ok) killOnCloseJob = job;
        return ok;
    }

    // Lets the job's processes outlive this one after all.
    public static void KeepJobProcesses()
    {
        if (killOnCloseJob == IntPtr.Zero) return;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        SetInformationJobObject(killOnCloseJob, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info));
    }

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

    // Null when the pipe cannot be reached in ms (Connect keeps retrying while it does not exist).
    public static NamedPipeClientStream Connect(string name, int ms = ReachMs)
    {
        // Identification only: a server squatting on the name cannot act as this user.
        NamedPipeClientStream pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.None,
            TokenImpersonationLevel.Identification);
        try
        {
            pipe.Connect(ms);
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

    // Sends one request line and returns the reply line, or null (the reason on stderr) when no
    // listener takes it. A connection that breaks first (the listener restarting) is made again and
    // the line sent again; one that keeps breaking at once is a listener refusing the line.
    public static byte[] Request(string name, byte[] line)
    {
        for (int quickBreaks = 0; quickBreaks < 5; )
        {
            using (NamedPipeClientStream pipe = Connect(name))
            {
                if (pipe == null)
                {
                    Unreachable();
                    return null;
                }
                Stopwatch connected = Stopwatch.StartNew();
                try
                {
                    pipe.Write(line, 0, line.Length);
                    byte[] reply = ReadLine(pipe, 65536, false);
                    if (reply != null) return reply;
                }
                catch (IOException)
                {
                }
                quickBreaks = connected.ElapsedMilliseconds < 1000 ? quickBreaks + 1 : 0;
            }
            Thread.Sleep(200 * quickBreaks);
        }
        Console.Error.WriteLine("cc-askpass: the cc-askpass listener keeps closing the connection without a reply");
        return null;
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

// ssh's arguments split as bin/shim/ssh's parse_args does (getopts with ssh's option string).
// Like ssh, options after the host are options too, unless `--` came first.
sealed class SshArgs
{
    // The letters of ssh's options, each followed by ':' when it takes a value.
    const string OptString = "1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy";

    // The options for the relay connection: without the caller's multiplexing (a socket the
    // caller names can be a fake master that receives the answer), -t (a terminal echoes the
    // answer back as a request line; -T is added) and -n (the relay needs its stdin).
    public readonly List<string> RelayOptions = new List<string>();
    public readonly string Host = "";
    public readonly string Command;
    public readonly int CommandStart;
    // An unknown option or one of -N -W -O -s -G -V -Q -f.
    public bool PassFlag;
    // -f or ForkAfterAuthentication: ssh goes on in the background after the wrapper exits.
    public bool Forks;
    // A blank in a word up to the host (bin/shim/ssh: the mod reads the host back from ps).
    public readonly bool Spaced;

    public SshArgs(string[] args)
    {
        int i = Options(args, 0);
        bool ended = i > 0 && args[i - 1] == "--";
        for (int j = 0; j <= i && j < args.Length; j++)
            foreach (char c in args[j])
                if (c == ' ' || (c >= '\t' && c <= '\r')) Spaced = true;
        if (i < args.Length) Host = args[i++];
        while (!ended && i < args.Length && args[i].Length > 1 && args[i][0] == '-')
        {
            i = Options(args, i);
            ended = args[i - 1] == "--";
        }
        CommandStart = i;
        Command = string.Join(" ", args, i, args.Length - i);
    }

    // getopts from args[i] on; returns the index after the words it used.
    int Options(string[] args, int i)
    {
        while (i < args.Length)
        {
            string word = args[i];
            if (word == "--") return i + 1;
            if (word.Length < 2 || word[0] != '-') return i;
            i++;
            for (int k = 1; k < word.Length; k++)
            {
                char opt = word[k];
                int at = opt == ':' ? -1 : OptString.IndexOf(opt);
                if (at < 0)
                {
                    // ssh rejects it with its own message.
                    PassFlag = true;
                    continue;
                }
                string value = null;
                if (at + 1 < OptString.Length && OptString[at + 1] == ':')
                {
                    if (k + 1 < word.Length) value = word.Substring(k + 1);
                    else if (i < args.Length) value = args[i++];
                    else
                    {
                        PassFlag = true;
                        break;
                    }
                    k = word.Length;
                }
                Add(opt, value);
            }
        }
        return i;
    }

    void Add(char opt, string value)
    {
        if ("NWOsGVQf".IndexOf(opt) >= 0) PassFlag = true;
        if (opt == 'f') Forks = true;
        if ("SMtTn".IndexOf(opt) >= 0) return;
        if (opt == 'o')
        {
            // "Key=value", "Key value" or "Key = value", the key and value in any case.
            int cut = value.IndexOfAny(new char[] { '=', ' ', '\t' });
            string key = (cut < 0 ? value : value.Substring(0, cut)).ToLowerInvariant();
            string setting = cut < 0 ? "" : value.Substring(cut).TrimStart('=', ' ', '\t').TrimEnd().ToLowerInvariant();
            bool yes = setting == "yes" || setting == "true";
            // The -f, -n and -N/-s of a config line: a child forked past the wrapper would die with
            // its job, and a session without stdin or a command has no prompt to relay.
            if ((key == "forkafterauthentication" || key == "stdinnull") && yes ||
                key == "sessiontype" && (setting == "none" || setting == "subsystem")) PassFlag = true;
            if (key == "forkafterauthentication" && yes) Forks = true;
            if (key == "controlpath" || key == "controlmaster") return;
        }
        RelayOptions.Add("-" + opt);
        if (value != null) RelayOptions.Add(value);
    }
}

// shim\ssh.exe (spec §6): runs the real ssh, and when a password prompt on the remote host can
// reach the pane, runs the command over a second connection R that relays the remote askpass.
// It never writes to stdout: that belongs to the user's command.
static class SshWrapper
{
    const int CommandLineMax = 32767;
    // The longest token directory accepted from the remote, so C's length is known beforehand.
    const int DirMax = 256;
    // Git's ssh (MSYS) cuts a quoted word from a Windows program at this many UTF-16 units.
    const int MsysWordMax = 8186;
    // The real ssh is an MSYS or Cygwin program, which reads its command line itself.
    static bool msys;
    const string Eval = "eval \"$(printf %s \"$CCAP_RS_B64\" | base64 -d 2>/dev/null || printf %s \"$CCAP_RS_B64\" | base64 -D)\"";

    public static int Run(string self, string[] args)
    {
        string shimDir = Path.GetDirectoryName(self);
        string realSsh = FindRealSsh(shimDir);
        if (realSsh == null)
        {
            Console.Error.WriteLine("cc-askpass: ssh: command not found");
            return 255;
        }
        string sshDir = Path.GetDirectoryName(realSsh);
        msys = File.Exists(Path.Combine(sshDir, "msys-2.0.dll")) || File.Exists(Path.Combine(sshDir, "cygwin1.dll"));
        SshArgs parsed = new SshArgs(args);
        // R and C pass on only words of these (or shorter, or base64): they fit when these fit.
        List<string> words = msys ? MsysWords(args, parsed.CommandStart) : new List<string>(args);
        if (words == null) return 255;
        if (ShouldWrap(parsed, Path.Combine(Path.GetDirectoryName(shimDir), "cc-askpass.exe")))
        {
            int? status = Wrap(realSsh, args, parsed, shimDir);
            if (status != null) return status.Value;
        }
        // As exec does on Linux: killing the wrapper ends ssh too (a -L tunnel frees its port),
        // unless ssh forks to outlive it. Without a job this is plain ssh: no warning.
        if (!parsed.Forks) EnterJob(false);
        try
        {
            using (Process ssh = Start(realSsh, words, false))
            {
                ssh.WaitForExit();
                // ssh ended by itself: what it left in the background (a ControlPersist master, a
                // config's ForkAfterAuthentication) stays, as on Linux.
                Native.KeepJobProcesses();
                return ssh.ExitCode;
            }
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            Console.Error.WriteLine("cc-askpass: cannot start " + realSsh + " (Windows error " + error.NativeErrorCode + ")");
            return 255;
        }
    }

    // The first ssh on PATH that is not a cc-askpass wrapper: this one, or another build's copy
    // (two wrappers would start each other forever), known by the helper beside its directory.
    public static string FindRealSsh(string shimDir)
    {
        string[] exts = (Environment.GetEnvironmentVariable("PATHEXT") ?? ".COM;.EXE").Split(';');
        foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            string dir = entry.Trim().Trim('"');
            if (dir.Length == 0) continue;
            try
            {
                if (string.Equals(Path.GetFullPath(dir).TrimEnd('\\'), shimDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
                    File.Exists(Path.Combine(dir, @"..\cc-askpass.exe"))) continue;
                foreach (string ext in exts)
                {
                    // Only programs CreateProcess starts itself: a .cmd or .bat would run through cmd.exe.
                    if (!ext.Equals(".exe", StringComparison.OrdinalIgnoreCase) &&
                        !ext.Equals(".com", StringComparison.OrdinalIgnoreCase)) continue;
                    string candidate = Path.Combine(dir, "ssh" + ext);
                    if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                }
            }
            catch (Exception)
            {
                // Not a usable path.
            }
        }
        return null;
    }

    // bin/shim/ssh's should_wrap.
    public static bool ShouldWrap(SshArgs args, string helper)
    {
        // The shim stays on PATH for the whole session; this live switch is remoteHosts.
        if (Environment.GetEnvironmentVariable("CC_ASKPASS_WRAP") != "1") return false;
        // The relay asks the listener this helper asks; an SSH_ASKPASS naming another is not ours to use.
        if (!SamePath(Environment.GetEnvironmentVariable("SSH_ASKPASS"), helper)) return false;
        if (args.Command.Length == 0 || args.PassFlag || args.Spaced) return false;
        if (IsProtocolCommand(args.Command)) return false;
        string name = HostName(args.Host);
        if (IsExcluded(name)) return false;
        // The name goes into the request lines, where the mod shows it.
        // \z, not $: $ also matches before a final \n.
        if (!Regex.IsMatch(name, @"\A[A-Za-z0-9._@:%-]+\z")) return false;
        string pipe = Pipes.Name();
        if (string.IsNullOrEmpty(pipe)) return false;
        using (NamedPipeClientStream listener = Pipes.Connect(pipe, 1000)) return listener != null;
    }

    static bool SamePath(string a, string b)
    {
        if (string.IsNullOrEmpty(a)) return false;
        try
        {
            return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception)
        {
            return false;
        }
    }

    // A machine protocol that needs a clean channel.
    static bool IsProtocolCommand(string command)
    {
        string[] words = command.Split(new char[] { ' ', '\t', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return false;
        switch (words[0].Substring(words[0].LastIndexOf('/') + 1))
        {
            case "git-upload-pack":
            case "git-receive-pack":
            case "git-upload-archive":
            case "sftp-server":
            case "internal-sftp":
                return true;
            case "scp":
                return Array.IndexOf(words, "-t", 1) > 0 || Array.IndexOf(words, "-f", 1) > 0;
            case "rsync":
                return command.IndexOf("sudo", StringComparison.Ordinal) < 0 && Array.IndexOf(words, "--server", 1) > 0;
            case "borg":
                return words.Length > 1 && words[1] == "serve";
        }
        return false;
    }

    // The host without ssh://, user@ and :port; a bare IPv6 address (several colons) stays whole.
    static string HostName(string host)
    {
        string name = host.StartsWith("ssh://", StringComparison.Ordinal) ? host.Substring(6) : host;
        bool isUrl = name.Length != host.Length;
        name = name.Substring(name.LastIndexOf('@') + 1);
        int colon = name.IndexOf(':');
        if (colon >= 0 && (isUrl || name.IndexOf(':', colon + 1) < 0)) name = name.Substring(0, name.LastIndexOf(':'));
        return name;
    }

    // The name matches a CC_ASKPASS_EXCLUDE glob (one per line, sh's *, ? and [...]).
    static bool IsExcluded(string name)
    {
        foreach (string glob in (Environment.GetEnvironmentVariable("CC_ASKPASS_EXCLUDE") ?? "").Split('\n'))
        {
            string pattern = glob.TrimEnd('\r');
            if (pattern.Length == 0) continue;
            StringBuilder regex = new StringBuilder("^");
            for (int i = 0; i < pattern.Length; i++)
            {
                char c = pattern[i];
                int end = c == '[' && i + 2 <= pattern.Length ? pattern.IndexOf(']', i + 2) : -1;
                if (c == '*') regex.Append(".*");
                else if (c == '?') regex.Append('.');
                else if (end > 0)
                {
                    string set = pattern.Substring(i + 1, end - i - 1).Replace(@"\", @"\\").Replace("[", @"\[");
                    regex.Append('[').Append(set[0] == '!' ? "^" + set.Substring(1) : set).Append(']');
                    i = end;
                }
                else regex.Append(Regex.Escape(c.ToString()));
            }
            try
            {
                if (Regex.IsMatch(name, regex.Append(@"\z").ToString(), RegexOptions.Singleline)) return true;
            }
            catch (ArgumentException)
            {
                // A pattern we cannot read: the host may be one the person excluded.
                return true;
            }
        }
        return false;
    }

    // A word both command-line parsers read the same bare: no wildcard, blank, quote, backslash,
    // ~, {} or @. \z, not $: $ also matches before a final \n.
    static bool IsPlain(string word)
    {
        return Regex.IsMatch(word, @"\A[A-Za-z0-9+/=._,:%-]+\z");
    }

    // Every word quoted unless it is plain (base64, our own words). An MSYS or Cygwin program reads
    // the line itself: it expands wildcards, ~, {} and @file in unquoted words and honours '
    // quotes; inside "..." it reads \\ as \ and \" as " (any other \ stays) and cuts the word at
    // MsysWordMax, so a plain one stays bare. Anything else gets the standard Windows quoting
    // (CommandLineToArgvW and the C runtime).
    public static string QuoteArg(string arg)
    {
        if (IsPlain(arg)) return arg;
        if (msys) return "\"" + arg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\')
            {
                slashes++;
                continue;
            }
            quoted.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }

    // args for an MSYS ssh with no quoted word over MsysWordMax: a long remote-command word is split
    // at spaces into pieces packed up to that length, a long plain piece going bare on its own (ssh
    // joins the words of the remote command with spaces again, so nothing changes). Null, with a
    // message, when a word cannot be split so: nothing may run cut short.
    static List<string> MsysWords(string[] args, int commandStart)
    {
        List<string> words = new List<string>();
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i].Length <= MsysWordMax || IsPlain(args[i]))
            {
                words.Add(args[i]);
                continue;
            }
            StringBuilder piece = null;
            foreach (string token in i >= commandStart ? args[i].Split(' ') : new string[] { args[i] })
            {
                if (token.Length > MsysWordMax && !IsPlain(token))
                {
                    Console.Error.WriteLine("cc-askpass: ssh: an argument of " + args[i].Length +
                        " characters is too long: the real ssh, an MSYS program, would get it cut at " + MsysWordMax +
                        " (a remote command may be longer where it has spaces); nothing was run");
                    return null;
                }
                if (piece != null && piece.Length + 1 + token.Length <= MsysWordMax)
                {
                    piece.Append(' ').Append(token);
                    continue;
                }
                if (piece != null) words.Add(piece.ToString());
                piece = new StringBuilder(token);
            }
            words.Add(piece.ToString());
        }
        return words;
    }

    static Process Start(string exe, List<string> args, bool redirect)
    {
        ProcessStartInfo info = new ProcessStartInfo(exe, string.Join(" ", args.ConvertAll(QuoteArg)));
        info.UseShellExecute = false;
        info.RedirectStandardInput = redirect;
        info.RedirectStandardOutput = redirect;
        if (redirect) info.StandardOutputEncoding = Pipes.Utf8;
        return Process.Start(info);
    }

    static void Kill(Process process)
    {
        try
        {
            process.Kill();
        }
        catch (Exception)
        {
            // Already gone.
        }
    }

    static string Base64File(string root, string name)
    {
        return Convert.ToBase64String(File.ReadAllBytes(Path.Combine(root, name)));
    }

    // C's remote command, remote.sh run in the token directory R made, as words ssh joins with
    // spaces: the long base64 one then needs no quotes (see QuoteArg).
    static string[] RunWords(string dir, string commandB64)
    {
        return new string[] { "env", "CCAP_DIR=" + dir, "CCAP_CMD_B64=" + commandB64, "/bin/sh", dir + "/remote.sh", "run" };
    }

    // The token directory of R's first line, or null: it goes into C's command unquoted.
    static string ReadyDir(string line, string token)
    {
        const string prefix = "cc-askpass-ready ";
        if (line == null || !line.StartsWith(prefix, StringComparison.Ordinal)) return null;
        string dir = line.Substring(prefix.Length);
        return dir.Length <= DirMax && Regex.IsMatch(dir, @"\A/[A-Za-z0-9._/+@-]*/cc-askpass-" + token + @"\z") ? dir : null;
    }

    static int ReadyMs()
    {
        // Tests only, when non-empty.
        string test = Environment.GetEnvironmentVariable("CC_ASKPASS_TEST_READY_MS");
        int ms;
        return !string.IsNullOrEmpty(test) && int.TryParse(test, NumberStyles.None, CultureInfo.InvariantCulture, out ms) ? ms : 60000;
    }

    // Runs the command as C beside the relay connection R; null when it should run unwrapped.
    static int? Wrap(string realSsh, string[] args, SshArgs parsed, string shimDir)
    {
        string root = Path.GetFullPath(Path.Combine(shimDir, @"..\..\..\.."));
        byte[] random = new byte[16];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(random);
        string token = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
        string[] remoteWords;
        byte[] payload;
        try
        {
            // A's one-line command as words; askpass and the ssh wrapper do not fit beside it, so stdin carries them.
            remoteWords = new string[]
            {
                "env", "CCAP_RS_B64=" + Base64File(root, @"bin\remote.sh"), "/bin/sh", "-c", "'" + Eval + "'", "_",
                "serve-stdin", token
            };
            payload = Encoding.ASCII.GetBytes(Base64File(root, @"bin\askpass") + " " + Base64File(root, @"bin\shim\ssh") + "\n");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("cc-askpass: cannot read the remote scripts in " + root + "\\bin (" + error.GetType().Name + "); running ssh unwrapped");
            return null;
        }

        string commandB64 = Convert.ToBase64String(Pipes.Utf8.GetBytes(parsed.Command));
        List<string> commandArgs = new List<string>(args);
        commandArgs.RemoveRange(parsed.CommandStart, args.Length - parsed.CommandStart);
        int commandAt = commandArgs.Count;
        commandArgs.AddRange(RunWords(new string('x', DirMax), commandB64));
        if (QuoteArg(realSsh).Length + 1 + string.Join(" ", commandArgs.ConvertAll(QuoteArg)).Length >= CommandLineMax) return null;

        EnterJob(true);
        // R forwards nothing (C's own forwards would not bind) and never has a terminal (one would
        // echo the answer back as a request line). The first -o wins; -x -a -T win after the caller's.
        List<string> relayArgs = new List<string> { "-o", "ClearAllForwardings=yes" };
        relayArgs.AddRange(parsed.RelayOptions);
        relayArgs.AddRange(new string[] { "-x", "-a", "-T", "--", parsed.Host });
        relayArgs.AddRange(remoteWords);
        Process relay;
        try
        {
            relay = Start(realSsh, relayArgs, true);
        }
        catch (Exception)
        {
            return null;
        }

        // R's stdin has one writer thread, fed in order: the payload, then one answer per request.
        // ssh reads its stdin only once logged in, which may take a typed password, and a stalled
        // R may never read it again: nobody else ever waits on a write.
        Stream relayIn = relay.StandardInput.BaseStream;
        BlockingCollection<byte[]> toRelay = new BlockingCollection<byte[]>();
        toRelay.Add(payload);
        Background(delegate { Write(relayIn, toRelay); });
        string dir = null;
        try
        {
            Task<string> ready = relay.StandardOutput.ReadLineAsync();
            if (ready.Wait(ReadyMs())) dir = ReadyDir(ready.Result, token);
        }
        catch (AggregateException)
        {
        }
        if (dir == null)
        {
            Kill(relay);
            return null;
        }

        commandArgs.RemoveRange(commandAt, commandArgs.Count - commandAt);
        commandArgs.AddRange(RunWords(dir, commandB64));
        Process command;
        try
        {
            command = Start(realSsh, commandArgs, false);
        }
        catch (Exception)
        {
            Kill(relay);
            return null;
        }
        string name = HostName(parsed.Host);
        Background(delegate { Relay(relay, toRelay, realSsh, name); });

        command.WaitForExit();
        int status = command.ExitCode;
        // The writer then closes R's stdin, and EOF ends R: remote.sh removes the token directory
        // and exits. An R that has not ended by then (a writer stuck on it) is ended here.
        toRelay.CompleteAdding();
        if (!relay.WaitForExit(5000)) Kill(relay);
        // C ended by itself: what it left in the background stays, as for a pass-through.
        Native.KeepJobProcesses();
        return status;
    }

    static bool inJob;

    // Every ssh started from here on ends with this process (once is enough: the job is kept).
    static void EnterJob(bool warn)
    {
        if (inJob) return;
        inJob = true;
        int jobError;
        if (!Native.EnterKillOnCloseJob(out jobError) && warn)
            Console.Error.WriteLine("cc-askpass: could not set up a job object (Windows error " + jobError +
                "); ssh processes may outlive an interrupted command");
    }

    static void Background(ThreadStart body)
    {
        Thread thread = new Thread(body);
        thread.IsBackground = true;
        thread.Start();
    }

    static void Write(Stream relayIn, BlockingCollection<byte[]> queue)
    {
        try
        {
            foreach (byte[] bytes in queue.GetConsumingEnumerable())
            {
                relayIn.Write(bytes, 0, bytes.Length);
                relayIn.Flush();
            }
        }
        catch (IOException)
        {
            // R is gone.
        }
        finally
        {
            try
            {
                relayIn.Dispose();
            }
            catch (IOException)
            {
            }
        }
    }

    // Each request line R prints (A §4.6) goes to the listener as a relay request; the answer goes
    // back to R as <remote pid>\t<answer>\n, an empty one when nobody answers.
    static void Relay(Process relay, BlockingCollection<byte[]> toRelay, string realSsh, string host)
    {
        string pipe = Pipes.Name();
        try
        {
            string line;
            while ((line = relay.StandardOutput.ReadLine()) != null)
            {
                // Remote text: <pid> TAB <prompt> [TAB <via> TAB <reported>], under PIPE_BUF.
                if (line.Length > 4096) continue;
                string[] fields = line.Split(new char[] { '\t' }, 4);
                int pid;
                if (fields.Length < 2 ||
                    !int.TryParse(fields[0], NumberStyles.None, CultureInfo.InvariantCulture, out pid)) continue;
                string via = fields.Length > 2 && fields[2].Length > 0 ? fields[2] + " via " + host : host;
                string reported = fields.Length > 3 ? fields[3] : "";

                MemoryStream request = new MemoryStream();
                foreach (byte[] field in new byte[][]
                {
                    Pipes.Utf8.GetBytes("relay"), Pipes.Field(host, 255), Pipes.Field(realSsh, 1024),
                    Pipes.Utf8.GetBytes(fields[0]), Pipes.Field(fields[1], 1000), Pipes.Field(via, 1000),
                    Pipes.Field(reported, 2000)
                })
                {
                    if (request.Length > 0) request.WriteByte((byte)'\t');
                    request.Write(field, 0, field.Length);
                }
                request.WriteByte((byte)'\n');
                byte[] answer = Pipes.Request(pipe, request.ToArray()) ?? new byte[0];

                // The answer's bytes go out as they came, never decoded; \n only.
                MemoryStream reply = new MemoryStream();
                byte[] head = Encoding.ASCII.GetBytes(fields[0] + "\t");
                reply.Write(head, 0, head.Length);
                reply.Write(answer, 0, answer.Length);
                reply.WriteByte((byte)'\n');
                // Refused once the command has ended: the catch below ends this thread.
                toRelay.Add(reply.ToArray());
            }
        }
        catch (Exception)
        {
            // R is gone, or its output is unreadable: the command runs on without the relay
            // (a crash here would end it).
        }
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
        if (reply == null) return 1;
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
        if (!Native.ParentPids().TryGetValue(self, out claudePid) || claudePid == 0)
        {
            Console.Error.WriteLine("cc-askpass: cannot find the listener's parent process");
            return 1;
        }
        // The kernel's name for this exe (a junction or subst drive resolved), as it names the clients.
        string image = Native.ImagePath(self);
        if (image == null)
        {
            Console.Error.WriteLine("cc-askpass: cannot read the listener's own executable path");
            return 1;
        }
        string name = "cc-askpass-" + session + "-" + claudePid;
        NamedPipeServerStream requests = CreateFirst(name);
        NamedPipeServerStream replies = requests == null ? null : CreateFirst(name + "-reply");
        if (replies == null) return 1;

        byte[] random = new byte[16];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(random);
        token = BitConverter.ToString(random).Replace("-", "").ToLowerInvariant();
        // Raw bytes, not Console.Out: setting Console.OutputEncoding would change a shared console's code page.
        stdout = Console.OpenStandardOutput();
        Print("ready\t" + name + "\t" + token + "\t" + image);

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
            // The asker sends nothing more: this read ends when the asker goes or the reply closes it.
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
        catch (OperationCanceledException)
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
                // Closed once the asker has read it, so the reply never races the close.
                asker.WaitForPipeDrain();
            }
            catch (IOException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
            finally
            {
                asker.Dispose();
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
