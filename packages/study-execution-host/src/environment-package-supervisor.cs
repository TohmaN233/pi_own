using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// The worker starts this program, not the package manager.  The package-manager
// process is created suspended, placed in a kill-on-close Job, and only resumed
// after the worker has durably recorded this supervisor's process identity.
public static class EnvironmentPackageSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
        public long ToLong()
        {
            return ((long)dwHighDateTime << 32) + dwLowDateTime;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string path, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--inspect") return InspectExact(args[1]);
            if (args.Length == 4 && args[0] == "--terminate") return TerminateExact(args[1], args[2], args[3]);
            return RunGated(args);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("environment package supervisor failed: " + error.Message);
            return 70;
        }
    }

    private static int RunGated(string[] args)
    {
        string readyFile = null;
        string releaseFile = null;
        string gateToken = null;
        string currentDirectory = null;
        int gateTimeoutMs = 0;
        int separator = -1;
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "--") { separator = index; break; }
            if (index + 1 >= args.Length) throw new InvalidOperationException("supervisor option has no value");
            string option = args[index++];
            string value = args[index];
            if (option == "--ready-file") readyFile = value;
            else if (option == "--release-file") releaseFile = value;
            else if (option == "--gate-token") gateToken = value;
            else if (option == "--cwd") currentDirectory = value;
            else if (option == "--gate-timeout-ms") gateTimeoutMs = ParsePositive(value, "gate timeout");
            else throw new InvalidOperationException("unknown supervisor option " + option);
        }
        if (separator < 0 || separator + 1 >= args.Length) throw new InvalidOperationException("supervisor command is missing");
        if (!Path.IsPathRooted(readyFile) || !Path.IsPathRooted(releaseFile) || !Path.IsPathRooted(currentDirectory))
            throw new InvalidOperationException("supervisor paths must be absolute");
        if (String.IsNullOrWhiteSpace(gateToken) || gateToken.Length > 256 || gateTimeoutMs < 100 || gateTimeoutMs > 300000)
            throw new InvalidOperationException("supervisor gate is invalid");
        if (File.Exists(readyFile) || File.Exists(releaseFile)) throw new InvalidOperationException("supervisor gate files already exist");
        string executable = args[separator + 1];
        if (!Path.IsPathRooted(executable) || !File.Exists(executable)) throw new InvalidOperationException("package executable must be an existing absolute path");
        string commandLine = Quote(executable);
        for (int index = separator + 2; index < args.Length; index++) commandLine += " " + Quote(args[index]);

        IntPtr job = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        IntPtr stdin = IntPtr.Zero;
        PROCESS_INFORMATION child = new PROCESS_INFORMATION();
        Thread stdoutPump = null;
        Thread stderrPump = null;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            ThrowIfZero(job, "CreateJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr limitsMemory = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsMemory, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsMemory, (uint)limitsSize)) ThrowLastError("SetInformationJobObject");
            }
            finally { Marshal.FreeHGlobal(limitsMemory); }

            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
            if (!CreatePipe(out stdoutRead, out stdoutWrite, ref attributes, 0)) ThrowLastError("CreatePipe stdout");
            if (!CreatePipe(out stderrRead, out stderrWrite, ref attributes, 0)) ThrowLastError("CreatePipe stderr");
            if (!SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("SetHandleInformation stdout");
            if (!SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("SetHandleInformation stderr");
            stdin = CreateFile("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            ThrowIfInvalid(stdin, "CreateFile NUL");

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = stdin;
            startup.hStdOutput = stdoutWrite;
            startup.hStdError = stderrWrite;
            StringBuilder mutableCommandLine = new StringBuilder(commandLine);
            if (!CreateProcess(executable, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, currentDirectory, ref startup, out child))
                ThrowLastError("CreateProcess");
            if (!AssignProcessToJobObject(job, child.hProcess)) ThrowLastError("AssignProcessToJobObject");

            CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
            CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;
            stdoutPump = StartPump(stdoutRead, Console.OpenStandardOutput()); stdoutRead = IntPtr.Zero;
            stderrPump = StartPump(stderrRead, Console.OpenStandardError()); stderrRead = IntPtr.Zero;

            string supervisorCreationIdentity = ProcessCreationIdentity(Process.GetCurrentProcess().Handle);
            string supervisorStartedAt = DateTime.FromFileTimeUtc(Int64.Parse(supervisorCreationIdentity)).ToString("o");
            AtomicWrite(readyFile, "{\"supervisorPid\":" + Process.GetCurrentProcess().Id + ",\"installerPid\":" + child.dwProcessId + ",\"processCreationIdentity\":\"" + supervisorCreationIdentity + "\"}");
            Console.Out.WriteLine("@pi-environment-supervisor-ready " + gateToken + " " + supervisorStartedAt + " " + supervisorCreationIdentity);
            Console.Out.Flush();
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(gateTimeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                if (File.Exists(releaseFile) && File.ReadAllText(releaseFile, Encoding.UTF8) == gateToken)
                {
                    if (ResumeThread(child.hThread) == 0xFFFFFFFF) ThrowLastError("ResumeThread");
                    CloseHandle(child.hThread); child.hThread = IntPtr.Zero;
                    uint wait = WaitForSingleObject(child.hProcess, INFINITE);
                    if (wait == WAIT_FAILED) ThrowLastError("WaitForSingleObject");
                    if (wait != WAIT_OBJECT_0) throw new InvalidOperationException("package installer wait did not complete");
                    uint exitCode;
                    if (!GetExitCodeProcess(child.hProcess, out exitCode)) ThrowLastError("GetExitCodeProcess");
                    stdoutPump.Join();
                    stderrPump.Join();
                    return unchecked((int)exitCode);
                }
                Thread.Sleep(25);
            }
            throw new TimeoutException("durable supervisor registration gate timed out before release");
        }
        finally
        {
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (stdin != IntPtr.Zero) CloseHandle(stdin);
            if (stdoutRead != IntPtr.Zero) CloseHandle(stdoutRead);
            if (stdoutWrite != IntPtr.Zero) CloseHandle(stdoutWrite);
            if (stderrRead != IntPtr.Zero) CloseHandle(stderrRead);
            if (stderrWrite != IntPtr.Zero) CloseHandle(stderrWrite);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static int InspectExact(string processIdText)
    {
        int processId = ParsePositive(processIdText, "process id");
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return 3;
        try
        {
            Console.Out.WriteLine("{\"pid\":" + processId + ",\"processCreationIdentity\":\"" + ProcessCreationIdentity(process) + "\"}");
            return 0;
        }
        finally { CloseHandle(process); }
    }

    private static int TerminateExact(string processIdText, string processCreationIdentityText, string timeoutText)
    {
        int processId = ParsePositive(processIdText, "process id");
        int timeoutMs = ParsePositive(timeoutText, "termination timeout");
        long processCreationIdentity;
        if (!Int64.TryParse(processCreationIdentityText, out processCreationIdentity) || processCreationIdentity < 1)
            throw new InvalidOperationException("process creation identity is invalid");
        IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, processId);
        if (process == IntPtr.Zero) return 3;
        try
        {
            if (Int64.Parse(ProcessCreationIdentity(process)) != processCreationIdentity) return 4;
            if (!TerminateProcess(process, 1)) ThrowLastError("TerminateProcess");
            uint wait = WaitForSingleObject(process, (uint)timeoutMs);
            if (wait == WAIT_OBJECT_0) return 0;
            if (wait == WAIT_FAILED) ThrowLastError("WaitForSingleObject termination");
            return 5;
        }
        finally { CloseHandle(process); }
    }

    private static Thread StartPump(IntPtr readHandle, Stream destination)
    {
        Thread thread = new Thread(delegate()
        {
            using (FileStream source = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(readHandle, true), FileAccess.Read, 4096, false))
            {
                source.CopyTo(destination);
                destination.Flush();
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static string ProcessCreationIdentity(IntPtr process)
    {
        FILETIME creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) ThrowLastError("GetProcessTimes");
        return creation.ToLong().ToString();
    }

    private static void AtomicWrite(string path, string contents)
    {
        string temporary = Path.Combine(Path.GetDirectoryName(path), ".gate.tmp");
        using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.Write(contents);
        File.Move(temporary, path);
    }

    private static int ParsePositive(string value, string label)
    {
        int parsed;
        if (!Int32.TryParse(value, out parsed) || parsed < 1) throw new InvalidOperationException(label + " is invalid");
        return parsed;
    }

    private static string Quote(string value)
    {
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') quoted.Append('\\', slashes * 2 + 1).Append('"');
            else quoted.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2).Append('"');
        return quoted.ToString();
    }

    private static void ThrowIfZero(IntPtr value, string operation)
    {
        if (value == IntPtr.Zero) ThrowLastError(operation);
    }

    private static void ThrowIfInvalid(IntPtr value, string operation)
    {
        if (value == new IntPtr(-1)) ThrowLastError(operation);
    }

    private static void ThrowLastError(string operation)
    {
        throw new InvalidOperationException(operation + " failed with Win32 error " + Marshal.GetLastWin32Error());
    }
}
