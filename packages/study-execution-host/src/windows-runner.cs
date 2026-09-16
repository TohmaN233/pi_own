using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class StudyWindowsRunner
{
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateNoWindow = 0x08000000;
	private const uint Th32csSnapProcess = 0x00000002;
	private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint FileNameNormalized = 0x00000000;
    private const uint VolumeNameNt = 0x00000002;
    private const uint JobObjectLimitProcessMemory = 0x00000100;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint JobObjectCpuRateControlEnable = 0x00000001;
    private const uint JobObjectCpuRateControlHardCap = 0x00000004;
	private const int RunningReceiptProgressIntervalMilliseconds = 500;
	private const int JobObjectBasicProcessIdList = 3;
	private const uint ProcessQueryLimitedInformation = 0x00001000;
	private const uint Synchronize = 0x00100000;
	private const int ErrorInvalidParameter = 87;
    private static readonly IntPtr ProcThreadAttributeSecurityCapabilities = new IntPtr(0x00020009);
    private static readonly IntPtr ProcThreadAttributeHandleList = new IntPtr(0x00020002);
    private static readonly SecurityIdentifier AllApplicationPackages = new SecurityIdentifier("S-1-15-2-1");

    public static int Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--supervise") return Supervise(args[1]);
        if (args.Length == 3 && args[0] == "--cancel") return RequestCancel(args[1], args[2]);
        Console.Error.WriteLine("Usage: windows-runner.exe --supervise <config.json> | --cancel <control-dir> <token>");
        return 64;
    }

    private static int Supervise(string configPath)
    {
        RunnerConfig config = null;
        RunnerReceipt receipt = null;
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        ProcessInformation processInformation = new ProcessInformation();
        BoundedCapture stdoutCapture = null;
        BoundedCapture stderrCapture = null;
        SharedOutputBudget outputBudget = null;
        WorkerLocation worker = null;
        Stopwatch processStopwatch = null;
		FileStream supervisorLock = null;
        bool profileCreated = false;
        string profileName = null;
        try
        {
            config = ReadConfig(configPath);
			ValidateConfigPreflight(config, configPath);
			// The immutable control-path binding is enough to take the per-run
			// supervisor lock safely. Full byte validation follows while this lock is
			// held, so polling a Node ProcessId=0 launch receipt cannot start dozens
			// of concurrent hash passes over a large frozen Python environment.
			try
			{
				supervisorLock = new FileStream(Path.Combine(config.ControlDirectory, "supervisor.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
			}
			catch (IOException)
			{
				return 0;
			}
            if (HasPriorSupervisorReceipt(config)) return 0;
			if (IsCancelRequested(config))
			{
				receipt = NewUnlaunchedCancellationReceipt(config);
				return 1;
			}
            if (!ValidateConfig(config, configPath))
			{
				receipt = NewUnlaunchedCancellationReceipt(config);
				return 1;
			}
            if (HasPriorSupervisorReceipt(config)) return 0;
			if (IsCancelRequested(config))
			{
				receipt = NewUnlaunchedCancellationReceipt(config);
				return 1;
			}
            receipt = NewReceipt(config, "launching");
            WriteReceipt(config.ControlDirectory, "status.json", receipt);
			if (IsCancelRequested(config))
			{
				receipt = NewUnlaunchedCancellationReceipt(config);
				return 1;
			}

            profileName = "study-runner-" + config.RunId;
            int profileResult = CreateAppContainerProfile(profileName, profileName, "Study Windows isolated run", IntPtr.Zero, 0, out appContainerSid);
            if (profileResult != 0)
                throw new Win32Exception(profileResult, "CreateAppContainerProfile failed");
            profileCreated = true;

            SecurityIdentifier appContainerIdentity = new SecurityIdentifier(appContainerSid);
            worker = PrepareWorkerLocation(config, appContainerSid, appContainerIdentity);

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObject failed");
            ConfigureJob(job, config);
            outputBudget = new SharedOutputBudget(config.OutputLimitBytes);

            ChildPipes pipes = CreateChildPipes();
            try
            {
                processInformation = CreateAppContainerProcess(config, worker, appContainerSid, pipes);
            }
            finally
            {
                CloseHandle(pipes.StandardInputRead);
                CloseHandle(pipes.StandardOutputWrite);
                CloseHandle(pipes.StandardErrorWrite);
            }

            if (!AssignProcessToJobObject(job, processInformation.Process)) throw LastError("AssignProcessToJobObject failed");
            stdoutCapture = new BoundedCapture(pipes.StandardOutputRead, Path.Combine(config.OutputDirectory, "stdout.log"), outputBudget);
            stderrCapture = new BoundedCapture(pipes.StandardErrorRead, Path.Combine(config.OutputDirectory, "stderr.log"), outputBudget);
            stdoutCapture.Start();
            stderrCapture.Start();
			receipt.Status = "launching";
			receipt.ProcessId = processInformation.ProcessId;
            receipt.ProcessCreationFileTime = GetCreationFileTime(processInformation.Process);
            receipt.StartedAt = DateTime.UtcNow.ToString("O");
			// This receipt is the execution fence: if this supervisor crashes after
			// ResumeThread, a later invocation sees a process identity and never
            // creates a second worker for the same immutable configuration.
            WriteReceipt(config.ControlDirectory, "status.json", receipt);
			string terminalError = null;
			string terminalStatus;
			if (IsCancelRequested(config))
			{
				// Durable cancellation can arrive while a queue is recovering a
				// launch claim. The worker is still suspended, so cancel before any
				// user instruction receives CPU time.
				if (!TerminateJobObject(job, 0xC000013A)) throw LastError("TerminateJobObject pre-resume cancel failed");
				WaitForJobToEmpty(job, 2000);
				terminalStatus = "cancelled";
			}
			else
			{
				processStopwatch = Stopwatch.StartNew();
				if (ResumeThread(processInformation.Thread) == uint.MaxValue) throw LastError("ResumeThread failed");
				receipt.Status = "running";
				WriteReceipt(config.ControlDirectory, "status.json", receipt);
				terminalStatus = WaitForTerminalState(config, job, processInformation.Process, unchecked((uint)processInformation.ProcessId), outputBudget, receipt, processStopwatch, out terminalError);
			}
            uint exitCode;
            if (!GetExitCodeProcess(processInformation.Process, out exitCode)) throw LastError("GetExitCodeProcess failed");
            stdoutCapture.Join();
            stderrCapture.Join();
            receipt.Status = terminalStatus == "exited" ? (exitCode == 0 ? "succeeded" : "failed") : terminalStatus;
            if (!String.IsNullOrWhiteSpace(terminalError)) receipt.Error = terminalError;
            receipt.ExitCode = exitCode;
            receipt.FinishedAt = DateTime.UtcNow.ToString("O");
            receipt.StdoutBytes = stdoutCapture.WrittenBytes;
            receipt.StderrBytes = stderrCapture.WrittenBytes;
            receipt.StdoutTruncated = stdoutCapture.Truncated;
            receipt.StderrTruncated = stderrCapture.Truncated;
            try
            {
                HarvestWorkerOutput(worker.OutputDirectory, config.OutputDirectory, outputBudget);
            }
            catch (OutputLimitExceededException error)
            {
                receipt.Status = "limit-reached";
                receipt.Error = error.Message;
            }
            receipt.WallTimeMs = processStopwatch == null ? 0 : Math.Max(0, processStopwatch.ElapsedMilliseconds);
        }
        catch (Exception error)
        {
            if (receipt == null && config != null) receipt = NewReceipt(config, "failed");
            if (receipt != null)
            {
                receipt.Status = error is OutputLimitExceededException ? "limit-reached" : "failed";
                receipt.Error = error.GetType().Name + ": " + error.Message;
                receipt.FinishedAt = DateTime.UtcNow.ToString("O");
                receipt.WallTimeMs = processStopwatch == null ? 0 : Math.Max(0, processStopwatch.ElapsedMilliseconds);
            }
        }
        finally
        {
            if (processInformation.Thread != IntPtr.Zero) CloseHandle(processInformation.Thread);
            if (processInformation.Process != IntPtr.Zero) CloseHandle(processInformation.Process);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (appContainerSid != IntPtr.Zero) FreeSid(appContainerSid);
            string cleanup = null;
            if (worker != null)
            {
                try
                {
                    DeleteWorkspace(worker.WorkspaceDirectory);
                    cleanup = "workspace-deleted";
                }
                catch (Exception error)
                {
                    cleanup = "workspace-delete-failed:" + error.GetType().Name;
                }
            }
            if (profileCreated)
            {
                int cleanupResult = DeleteAppContainerProfile(profileName);
                string profileCleanup = cleanupResult == 0 ? "profile-deleted" : "profile-delete-failed:" + cleanupResult;
                if (receipt != null) receipt.AppContainerCleanup = (cleanup ?? "workspace-not-created") + ";" + profileCleanup;
            }
            if (receipt != null && config != null)
            {
                try
                {
                    WorkerOutputSummary retainedOutput = MeasureRetainedOutput(config.OutputDirectory);
                    receipt.OutputBytes = retainedOutput.Bytes;
                    receipt.OutputFiles = retainedOutput.Files;
                    if (retainedOutput.Bytes > config.OutputLimitBytes)
                    {
                        receipt.Status = "limit-reached";
                        receipt.Error = "Retained output exceeded its shared output limit";
                    }
                }
                catch (Exception error)
                {
                    receipt.Status = "failed";
                    receipt.Error = "Retained output measurement failed: " + error.GetType().Name + ": " + error.Message;
                    receipt.OutputBytes = 0;
                    receipt.OutputFiles = 0;
                }
            }
			try
			{
				if (receipt != null && config != null) WriteReceipt(config.ControlDirectory, "status.json", receipt);
			}
			finally
			{
				if (supervisorLock != null) supervisorLock.Dispose();
			}
        }
        return receipt != null && receipt.Status == "succeeded" ? 0 : 1;
    }

    private static int RequestCancel(string controlDirectory, string token)
    {
        try
        {
            string statusPath = Path.Combine(controlDirectory, "status.json");
            RunnerReceipt receipt = Deserialize<RunnerReceipt>(File.ReadAllText(statusPath));
            if (receipt == null || !FixedEquals(receipt.CancelTokenHash, Sha256(token))) return 3;
            if (receipt.Status != "running" && receipt.Status != "launching") return 0;
            CancelRequest request = new CancelRequest();
            request.Version = 1;
            request.RunId = receipt.RunId;
            request.ConfigBindingHash = receipt.ConfigBindingHash;
            request.CancelTokenHash = receipt.CancelTokenHash;
            AtomicWrite(Path.Combine(controlDirectory, "cancel.request"), Serialize(request));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }

    private static RunnerConfig ReadConfig(string configPath)
    {
        return Deserialize<RunnerConfig>(File.ReadAllText(configPath));
    }

    /**
     * Verifies private runtime bytes before execution. Returns false when the
     * authenticated durable cancellation request arrives before any worker can
     * be created.
     */
    private static bool ValidateConfig(RunnerConfig config, string configPath)
    {
        ValidateConfigPreflight(config, configPath);
        if (config.MemoryBytes < 64L * 1024L * 1024L || config.MemoryBytes > 1024L * 1024L * 1024L * 1024L || config.WallTimeMs < 100 || config.WallTimeMs > 24 * 60 * 60 * 1000)
            throw new InvalidOperationException("Unsafe runner limits");
        if (config.CpuRatePercent < 1 || config.CpuRatePercent > 100 || config.OutputLimitBytes < 1024 || config.OutputLimitBytes > 64 * 1024 * 1024)
            throw new InvalidOperationException("Invalid runner resource configuration");
        string runDirectory = Path.GetFullPath(config.RunDirectory);
        RequireWithin(runDirectory, config.ControlDirectory, "control directory");
        RequireWithin(runDirectory, config.RuntimeDirectory, "runtime directory");
        RequireWithin(runDirectory, config.InputDirectory, "input directory");
        RequireWithin(runDirectory, config.OutputDirectory, "output directory");
        RequireWithin(config.RuntimeDirectory, config.ExecutablePath, "executable");
        RequireWithin(config.InputDirectory, config.ProgramPath, "program");
        if (!String.IsNullOrWhiteSpace(config.PythonSitePackagesDirectory)) RequireWithin(config.RuntimeDirectory, config.PythonSitePackagesDirectory, "Python site-packages directory");
        if (!String.IsNullOrWhiteSpace(config.PythonLibraryBinDirectory)) RequireWithin(config.RuntimeDirectory, config.PythonLibraryBinDirectory, "Python native library directory");
        if (config.RLibraryDirectories != null)
            foreach (string libraryDirectory in config.RLibraryDirectories)
                RequireWithin(config.RuntimeDirectory, libraryDirectory, "R library directory");
        bool hasEnvironmentBinding = !String.IsNullOrWhiteSpace(config.EnvironmentAdapterKind) || !String.IsNullOrWhiteSpace(config.EnvironmentDescriptorHash);
        if (hasEnvironmentBinding && (String.IsNullOrWhiteSpace(config.EnvironmentAdapterKind) || !IsExecutionHash(config.EnvironmentDescriptorHash)))
            throw new InvalidOperationException("Environment descriptor binding is incomplete");
		if (IsCancelRequested(config)) return false;
        if (config.Language == "rscript")
        {
            if (String.IsNullOrWhiteSpace(config.CompatibilityAdapterPath) || String.IsNullOrWhiteSpace(config.CompatibilityAdapterHash) || String.IsNullOrWhiteSpace(config.CompatibilityRDllPath) || String.IsNullOrWhiteSpace(config.CompatibilityRDllHash))
                throw new InvalidOperationException("R AppContainer compatibility manifest is incomplete");
            RequireWithin(config.RuntimeDirectory, config.CompatibilityAdapterPath, "R compatibility adapter");
            RequireWithin(config.RuntimeDirectory, config.CompatibilityRDllPath, "R compatibility R.dll");
            if (!File.Exists(config.CompatibilityAdapterPath) || !FixedEquals(config.CompatibilityAdapterHash, Sha256File(config.CompatibilityAdapterPath)))
                throw new InvalidOperationException("R compatibility adapter hash mismatch");
            if (!File.Exists(config.CompatibilityRDllPath) || !FixedEquals(config.CompatibilityRDllHash, Sha256File(config.CompatibilityRDllPath)))
                throw new InvalidOperationException("R compatibility R.dll hash mismatch");
            if (!String.Equals(Path.GetFullPath(config.ExecutablePath), Path.GetFullPath(config.CompatibilityAdapterPath), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("R executable must be the manifest-bound compatibility adapter");
        }
		if (IsCancelRequested(config)) return false;
		if (ObserveTestSnapshotValidationDelay(config)) return false;
		foreach (FileDigest file in config.Files)
        {
            RequireWithin(runDirectory, file.Path, "hashed file");
        }
		Exception hashFailure = null;
		object hashFailureGate = new object();
		int cancellationObserved = 0;
		Parallel.ForEach(
			config.Files,
			new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, Math.Min(4, Environment.ProcessorCount)) },
			(file, loopState) =>
			{
				try
				{
					if (Volatile.Read(ref cancellationObserved) != 0 || IsCancelRequested(config))
					{
						Interlocked.Exchange(ref cancellationObserved, 1);
						loopState.Stop();
						return;
					}
					if (!File.Exists(file.Path) || !FixedEquals(file.Sha256, Sha256File(file.Path)))
						throw new InvalidOperationException("File hash mismatch: " + file.Path);
				}
				catch (Exception error)
				{
					lock (hashFailureGate) if (hashFailure == null) hashFailure = error;
				}
			});
		if (Volatile.Read(ref cancellationObserved) != 0 || IsCancelRequested(config)) return false;
		if (hashFailure != null) throw hashFailure;
		return true;
    }

	/**
	 * This is deliberately metadata-only: it authenticates the immutable
	 * control/configuration binding before we act on a cancellation request,
	 * without touching an executable or snapshot file. Full path and byte
	 * validation remains mandatory before any worker creation.
	 */
	private static void ValidateConfigPreflight(RunnerConfig config, string configPath)
	{
		if (config == null || config.Version != 1 || String.IsNullOrWhiteSpace(config.RunId))
			throw new InvalidOperationException("Invalid runner configuration");
		if (!IsSha256Digest(config.CancelTokenHash) || !IsSha256Digest(config.ConfigBindingHash))
			throw new InvalidOperationException("Missing runner control binding");
		if (config.Files == null || config.Files.Count == 0)
			throw new InvalidOperationException("Missing file hashes");
		foreach (FileDigest file in config.Files)
		{
			if (file == null || String.IsNullOrWhiteSpace(file.Path) || !IsSha256Digest(file.Sha256))
				throw new InvalidOperationException("Invalid file hash manifest");
		}
		ValidateConfigControlPath(config, configPath);
		string runDirectory = Path.GetFullPath(config.RunDirectory);
		if (!String.Equals(Path.GetFileName(runDirectory), "run-" + config.RunId, StringComparison.Ordinal))
			throw new InvalidOperationException("Run directory does not match the immutable run id");
		string expectedControlDirectory = Path.Combine(runDirectory, "control");
		if (!String.Equals(Path.GetFullPath(config.ControlDirectory), expectedControlDirectory, StringComparison.OrdinalIgnoreCase))
			throw new InvalidOperationException("Configuration control directory is not the direct private run control directory");
		if (!FixedEquals(config.ConfigBindingHash, BindingHash(config)))
			throw new InvalidOperationException("Configuration binding mismatch");
		ValidateLaunchClaim(config);
	}

	private static void ValidateLaunchClaim(RunnerConfig config)
	{
		string path = Path.Combine(config.ControlDirectory, "launch.claim");
		if (!File.Exists(path)) throw new InvalidOperationException("Launch claim is missing");
		LaunchClaim claim = Deserialize<LaunchClaim>(File.ReadAllText(path));
		if (
			claim == null ||
			!String.Equals(claim.RunId, config.RunId, StringComparison.Ordinal) ||
			!FixedEquals(claim.ConfigBindingHash, config.ConfigBindingHash) ||
			!String.Equals(claim.Disposition, "launch", StringComparison.Ordinal)
		)
			throw new InvalidOperationException("Launch claim does not match immutable configuration");
	}

	private static bool IsCancelRequested(RunnerConfig config)
	{
		string path = Path.Combine(config.ControlDirectory, "cancel.request");
		if (!File.Exists(path)) return false;
		CancelRequest request = Deserialize<CancelRequest>(File.ReadAllText(path));
		if (
			request == null ||
			request.Version != 1 ||
			!String.Equals(request.RunId, config.RunId, StringComparison.Ordinal) ||
			!FixedEquals(request.ConfigBindingHash, config.ConfigBindingHash) ||
			!FixedEquals(request.CancelTokenHash, config.CancelTokenHash)
		)
			throw new InvalidOperationException("Cancellation request does not match immutable configuration");
		return true;
	}

	/** Test-only bounded delay used to prove cancellation is observed during snapshot validation. */
	private static bool ObserveTestSnapshotValidationDelay(RunnerConfig config)
	{
		string configured = Environment.GetEnvironmentVariable("STUDY_WINDOWS_RUNNER_TEST_SNAPSHOT_VALIDATION_DELAY_MS");
		if (String.IsNullOrWhiteSpace(configured)) return false;
		int milliseconds;
		if (!Int32.TryParse(configured, out milliseconds) || milliseconds < 1 || milliseconds > 60000)
			throw new InvalidOperationException("Invalid test snapshot validation delay");
		AtomicWrite(Path.Combine(config.ControlDirectory, "test-snapshot-validation.started"), config.RunId + "\n");
		DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
		while (DateTime.UtcNow < deadline)
		{
			if (IsCancelRequested(config)) return true;
			Thread.Sleep(25);
		}
		return IsCancelRequested(config);
	}

	private static RunnerReceipt NewUnlaunchedCancellationReceipt(RunnerConfig config)
	{
		RunnerReceipt cancelled = NewReceipt(config, "cancelled");
		cancelled.FinishedAt = DateTime.UtcNow.ToString("O");
		cancelled.AppContainerCleanup = "not-started";
		cancelled.WallTimeMs = 0;
		return cancelled;
	}

	private static void ValidateConfigControlPath(RunnerConfig config, string configPath)
	{
		if (config == null || String.IsNullOrWhiteSpace(config.ControlDirectory))
			throw new InvalidOperationException("Configuration control directory is missing");
		if (Path.GetFullPath(configPath) != Path.GetFullPath(Path.Combine(config.ControlDirectory, "config.json")))
			throw new InvalidOperationException("Configuration must be read from its protected control directory");
	}

    private static void RequireWithin(string parent, string child, string name)
    {
        string normalizedParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string normalizedChild = Path.GetFullPath(child);
        if (!normalizedChild.StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Runner " + name + " escapes its run directory");
    }

    private static WorkerLocation PrepareWorkerLocation(RunnerConfig config, IntPtr appContainerSid, SecurityIdentifier appContainerIdentity)
    {
        string profileDirectory = GetAppContainerFolder(new SecurityIdentifier(appContainerSid).Value);
        // The AppContainer profile name already binds one unique run.  A one-segment child
        // keeps copied venv package paths below classic .NET Framework's 260-character API
        // limit without weakening the profile or filesystem boundary.
        string workspaceDirectory = Path.Combine(profileDirectory, "w");
        string runtimeDirectory = Path.Combine(workspaceDirectory, "runtime");
        string inputDirectory = Path.Combine(workspaceDirectory, "input");
        string outputDirectory = Path.Combine(workspaceDirectory, "output");
        Directory.CreateDirectory(runtimeDirectory);
        Directory.CreateDirectory(inputDirectory);
        RestrictAppContainerToReadOnly(runtimeDirectory, appContainerIdentity);
        RestrictAppContainerToReadOnly(inputDirectory, appContainerIdentity);
        FileSecurity readOnlyFileSecurity = CreateReadOnlyFileSecurity(appContainerIdentity);
        string inheritedExecutablePath = config.Language == "python" ? config.ExecutablePath : null;
        CopyDirectory(config.RuntimeDirectory, runtimeDirectory, readOnlyFileSecurity, inheritedExecutablePath, appContainerIdentity);
        CopyDirectory(config.InputDirectory, inputDirectory, readOnlyFileSecurity);
        Directory.CreateDirectory(outputDirectory);

        string executablePath = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, config.ExecutablePath));
        string programPath = Path.Combine(inputDirectory, RelativePath(config.InputDirectory, config.ProgramPath));
        foreach (FileDigest file in config.Files)
        {
            string copiedFile;
            if (IsWithin(config.RuntimeDirectory, file.Path))
                copiedFile = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, file.Path));
            else if (IsWithin(config.InputDirectory, file.Path))
                copiedFile = Path.Combine(inputDirectory, RelativePath(config.InputDirectory, file.Path));
            else
                throw new InvalidOperationException("Hashed file is not a runtime or input snapshot");
            if (!File.Exists(copiedFile) || !FixedEquals(file.Sha256, Sha256File(copiedFile)))
                throw new InvalidOperationException("Worker snapshot hash mismatch: " + copiedFile);
        }
        GrantAppContainerAccess(outputDirectory, appContainerIdentity, FileSystemRights.Modify);
        GrantAppContainerAccess(outputDirectory, AllApplicationPackages, FileSystemRights.Modify);

        WorkerLocation worker = new WorkerLocation();
        worker.WorkspaceDirectory = workspaceDirectory;
        worker.RuntimeDirectory = runtimeDirectory;
        worker.RuntimeBinDirectory = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, config.RuntimeBinDirectory));
        worker.RuntimeEnvironmentRoot = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, config.RuntimeEnvironmentRoot));
        worker.InputDirectory = inputDirectory;
        worker.OutputDirectory = outputDirectory;
        worker.ExecutablePath = executablePath;
        worker.ProgramPath = programPath;
        if (!String.IsNullOrWhiteSpace(config.PythonSitePackagesDirectory))
            worker.PythonSitePackagesDirectory = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, config.PythonSitePackagesDirectory));
        if (!String.IsNullOrWhiteSpace(config.PythonLibraryBinDirectory))
            worker.PythonLibraryBinDirectory = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, config.PythonLibraryBinDirectory));
        if (config.RLibraryDirectories != null)
            foreach (string libraryDirectory in config.RLibraryDirectories)
                worker.RLibraryDirectories.Add(Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, libraryDirectory)));
        if (config.Language == "rscript")
        {
            worker.CompatibilityAdapterPath = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, config.CompatibilityAdapterPath));
            worker.CompatibilityRDllPath = Path.Combine(runtimeDirectory, RelativePath(config.RuntimeDirectory, config.CompatibilityRDllPath));
            worker.CompatibilityAdapterHash = config.CompatibilityAdapterHash;
            worker.CompatibilityRDllHash = config.CompatibilityRDllHash;
            worker.TrustedDosDrive = GetTrustedDosDrive(outputDirectory);
            worker.TrustedNtVolume = GetTrustedNtVolumePrefix(outputDirectory);
        }
        return worker;
    }

    private static string GetAppContainerFolder(string appContainerSid)
    {
        IntPtr folder = IntPtr.Zero;
        int result = GetAppContainerFolderPath(appContainerSid, out folder);
        if (result != 0) throw new Win32Exception(result, "GetAppContainerFolderPath failed (HRESULT " + result + ")");
        try
        {
            string value = Marshal.PtrToStringUni(folder);
            if (String.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("AppContainer profile directory was empty");
            return Path.GetFullPath(value);
        }
        finally
        {
            if (folder != IntPtr.Zero) CoTaskMemFree(folder);
        }
    }

    private static string GetTrustedDosDrive(string directory)
    {
        string root = Path.GetPathRoot(Path.GetFullPath(directory));
        if (String.IsNullOrWhiteSpace(root) || root.Length < 3 || root[1] != ':')
            throw new InvalidOperationException("R compatibility requires a drive-rooted AppContainer profile");
        return root.Substring(0, 2);
    }

    private static string GetTrustedNtVolumePrefix(string directory)
    {
        string probePath = Path.Combine(directory, ".r-compat-volume-probe-" + Guid.NewGuid().ToString("N"));
        string expectedDosSuffix = Path.GetFullPath(probePath).Substring(2);
        try
        {
            using (FileStream probe = new FileStream(probePath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read))
            {
                uint required = GetFinalPathNameByHandle(probe.SafeFileHandle.DangerousGetHandle(), null, 0, FileNameNormalized | VolumeNameNt);
                if (required == 0 || required > 32768)
                    throw LastError("GetFinalPathNameByHandle R compatibility probe-size failed");
                StringBuilder buffer = new StringBuilder((int)required + 1);
                uint received = GetFinalPathNameByHandle(probe.SafeFileHandle.DangerousGetHandle(), buffer, (uint)buffer.Capacity, FileNameNormalized | VolumeNameNt);
                if (received == 0 || received >= buffer.Capacity)
                    throw LastError("GetFinalPathNameByHandle R compatibility probe failed");
                string ntPath = buffer.ToString();
                if (!ntPath.EndsWith(expectedDosSuffix, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("R compatibility NT path probe did not retain its verified DOS suffix");
                string prefix = ntPath.Substring(0, ntPath.Length - expectedDosSuffix.Length);
                if (String.IsNullOrWhiteSpace(prefix))
                    throw new InvalidOperationException("R compatibility NT path probe had no device prefix");
                return prefix.EndsWith("\\", StringComparison.Ordinal) ? prefix : prefix + "\\";
            }
        }
        finally
        {
            if (File.Exists(probePath)) File.Delete(probePath);
        }
    }

    private static void CopyDirectory(string sourceDirectory, string destinationDirectory, FileSecurity readOnlyFileSecurity)
    {
        CopyDirectory(sourceDirectory, destinationDirectory, readOnlyFileSecurity, null, null);
    }

    private static void CopyDirectory(string sourceDirectory, string destinationDirectory, FileSecurity readOnlyFileSecurity, string inheritedExecutablePath, SecurityIdentifier appContainerIdentity)
    {
        DirectoryInfo source = new DirectoryInfo(sourceDirectory);
        if (!source.Exists) throw new DirectoryNotFoundException("Snapshot directory was not found: " + sourceDirectory);
        if ((source.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Snapshot directory reparse points are rejected: " + sourceDirectory);
        Directory.CreateDirectory(destinationDirectory);
        foreach (FileInfo file in source.GetFiles())
        {
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Snapshot file reparse points are rejected: " + file.FullName);
            string destination = Path.Combine(destinationDirectory, file.Name);
            if (inheritedExecutablePath != null && String.Equals(Path.GetFullPath(file.FullName), Path.GetFullPath(inheritedExecutablePath), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(file.FullName, destination, false);
                RestrictFileToReadOnly(destination, appContainerIdentity);
            }
            else
                CopyFileWithReadOnlySecurity(file.FullName, destination, readOnlyFileSecurity);
        }
        foreach (DirectoryInfo directory in source.GetDirectories())
            CopyDirectory(directory.FullName, Path.Combine(destinationDirectory, directory.Name), readOnlyFileSecurity, inheritedExecutablePath, appContainerIdentity);
    }

    private static void CopyFileWithReadOnlySecurity(string sourcePath, string destinationPath, FileSecurity readOnlyFileSecurity)
    {
        using (FileStream source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (FileStream destination = new FileStream(destinationPath, FileMode.CreateNew, FileSystemRights.WriteData, FileShare.None, 4096, FileOptions.None, readOnlyFileSecurity))
            source.CopyTo(destination);
    }

    private static void DeleteWorkspace(string directory)
    {
        DirectoryInfo root = new DirectoryInfo(directory);
        if (!root.Exists) return;
        foreach (FileInfo file in root.GetFiles("*", SearchOption.AllDirectories))
            file.Attributes = FileAttributes.Normal;
        foreach (DirectoryInfo child in root.GetDirectories("*", SearchOption.AllDirectories))
            child.Attributes = FileAttributes.Normal;
        root.Attributes = FileAttributes.Normal;
        Directory.Delete(directory, true);
    }

    private static void RestrictAppContainerToReadOnly(string directory, SecurityIdentifier appContainerIdentity)
    {
        DirectoryInfo info = new DirectoryInfo(directory);
        DirectorySecurity security = info.GetAccessControl();
        FileSystemRights writeRights = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        AddDenyWriteRule(security, appContainerIdentity, writeRights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
        AddDenyWriteRule(security, AllApplicationPackages, writeRights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);
        security.AddAccessRule(new FileSystemAccessRule(
            appContainerIdentity,
            FileSystemRights.ReadAndExecute,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(
            AllApplicationPackages,
            FileSystemRights.ReadAndExecute,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        info.SetAccessControl(security);
    }

    private static FileSecurity CreateReadOnlyFileSecurity(SecurityIdentifier appContainerIdentity)
    {
        SecurityIdentifier controllerIdentity = WindowsIdentity.GetCurrent().User;
        if (controllerIdentity == null)
            throw new InvalidOperationException("The controller process has no Windows identity");

        FileSystemRights writeRights = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        FileSecurity security = new FileSecurity();
        security.AddAccessRule(new FileSystemAccessRule(controllerIdentity, FileSystemRights.FullControl, AccessControlType.Allow));
        AddDenyWriteRule(security, appContainerIdentity, writeRights, InheritanceFlags.None);
        AddDenyWriteRule(security, AllApplicationPackages, writeRights, InheritanceFlags.None);
        security.AddAccessRule(new FileSystemAccessRule(appContainerIdentity, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AllApplicationPackages, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        return security;
    }

    private static void RestrictFileToReadOnly(string filePath, SecurityIdentifier appContainerIdentity)
    {
        FileInfo info = new FileInfo(filePath);
        FileSecurity security = info.GetAccessControl();
        FileSystemRights writeRights = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteAttributes | FileSystemRights.WriteExtendedAttributes | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        AddDenyWriteRule(security, appContainerIdentity, writeRights, InheritanceFlags.None);
        AddDenyWriteRule(security, AllApplicationPackages, writeRights, InheritanceFlags.None);
        security.AddAccessRule(new FileSystemAccessRule(appContainerIdentity, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AllApplicationPackages, FileSystemRights.ReadAndExecute, AccessControlType.Allow));
        info.SetAccessControl(security);
    }

    private static void AddDenyWriteRule(FileSystemSecurity security, SecurityIdentifier identity, FileSystemRights rights, InheritanceFlags inheritance)
    {
        security.AddAccessRule(new FileSystemAccessRule(identity, rights, inheritance, PropagationFlags.None, AccessControlType.Deny));
    }

    private static void GrantAppContainerAccess(string directory, SecurityIdentifier appContainerIdentity, FileSystemRights rights)
    {
        DirectoryInfo info = new DirectoryInfo(directory);
        DirectorySecurity security = info.GetAccessControl();
        security.AddAccessRule(new FileSystemAccessRule(
            appContainerIdentity,
            rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        info.SetAccessControl(security);
    }

    private static bool IsWithin(string parent, string child)
    {
        string normalizedParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return Path.GetFullPath(child).StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase);
    }

    private static string RelativePath(string parent, string child)
    {
        string normalizedParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string normalizedChild = Path.GetFullPath(child);
        if (String.Equals(normalizedParent, normalizedChild, StringComparison.OrdinalIgnoreCase)) return String.Empty;
        if (!normalizedChild.StartsWith(normalizedParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Runner worker snapshot path escapes its root");
        return normalizedChild.Substring(normalizedParent.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static void ConfigureJob(IntPtr job, RunnerConfig config)
    {
        ExtendedLimitInformation limits = new ExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitProcessMemory | JobObjectLimitJobMemory | JobObjectLimitKillOnJobClose;
        limits.ProcessMemoryLimit = new UIntPtr((ulong)config.MemoryBytes);
        limits.JobMemoryLimit = new UIntPtr((ulong)config.MemoryBytes);
        SetJobInformation(job, 9, limits, "JobObjectExtendedLimitInformation");
        CpuRateControlInformation cpu = new CpuRateControlInformation();
        cpu.ControlFlags = JobObjectCpuRateControlEnable | JobObjectCpuRateControlHardCap;
        cpu.CpuRate = (uint)(config.CpuRatePercent * 100);
        SetJobInformation(job, 15, cpu, "JobObjectCpuRateControlInformation");
    }

    private static void SetJobInformation<T>(IntPtr job, int informationClass, T value, string name) where T : struct
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr memory = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(value, memory, false);
            if (!SetInformationJobObject(job, informationClass, memory, (uint)size)) throw LastError(name + " failed");
        }
        finally
        {
            Marshal.FreeHGlobal(memory);
        }
    }

    private static ChildPipes CreateChildPipes()
    {
        SecurityAttributes attributes = new SecurityAttributes();
        attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
        attributes.InheritHandle = true;
        ChildPipes pipes = new ChildPipes();
        if (!CreatePipe(out pipes.StandardInputRead, out pipes.StandardInputWrite, ref attributes, 0)) throw LastError("CreatePipe stdin failed");
        if (!CreatePipe(out pipes.StandardOutputRead, out pipes.StandardOutputWrite, ref attributes, 0)) throw LastError("CreatePipe stdout failed");
        if (!CreatePipe(out pipes.StandardErrorRead, out pipes.StandardErrorWrite, ref attributes, 0)) throw LastError("CreatePipe stderr failed");
        if (!SetHandleInformation(pipes.StandardInputWrite, HandleFlagInherit, 0)) throw LastError("SetHandleInformation stdin failed");
        if (!SetHandleInformation(pipes.StandardOutputRead, HandleFlagInherit, 0)) throw LastError("SetHandleInformation stdout failed");
        if (!SetHandleInformation(pipes.StandardErrorRead, HandleFlagInherit, 0)) throw LastError("SetHandleInformation stderr failed");
        CloseHandle(pipes.StandardInputWrite);
        pipes.StandardInputWrite = IntPtr.Zero;
        return pipes;
    }

    private static ProcessInformation CreateAppContainerProcess(RunnerConfig config, WorkerLocation worker, IntPtr appContainerSid, ChildPipes pipes)
    {
        IntPtr securityCapabilities = IntPtr.Zero;
        IntPtr handleList = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        try
        {
            SecurityCapabilities capabilities = new SecurityCapabilities();
            capabilities.AppContainerSid = appContainerSid;
            capabilities.Capabilities = IntPtr.Zero;
            capabilities.CapabilityCount = 0;
            securityCapabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
            Marshal.StructureToPtr(capabilities, securityCapabilities, false);

            handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleList, 0, pipes.StandardInputRead);
            Marshal.WriteIntPtr(handleList, IntPtr.Size, pipes.StandardOutputWrite);
            Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, pipes.StandardErrorWrite);
            IntPtr listSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref listSize);
            attributeList = Marshal.AllocHGlobal(listSize);
            if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref listSize)) throw LastError("InitializeProcThreadAttributeList failed");
            if (!UpdateProcThreadAttribute(attributeList, 0, ProcThreadAttributeSecurityCapabilities, securityCapabilities, (IntPtr)Marshal.SizeOf(typeof(SecurityCapabilities)), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute security capabilities failed");
            if (!UpdateProcThreadAttribute(attributeList, 0, ProcThreadAttributeHandleList, handleList, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                throw LastError("UpdateProcThreadAttribute handle list failed");

            StartupInfoEx startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = StartfUseStdHandles;
            startup.StartupInfo.hStdInput = pipes.StandardInputRead;
            startup.StartupInfo.hStdOutput = pipes.StandardOutputWrite;
            startup.StartupInfo.hStdError = pipes.StandardErrorWrite;
            startup.AttributeList = attributeList;
            environment = AllocateEnvironment(BuildEnvironment(config, worker));
            ProcessInformation process;
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(config, worker));
            uint flags = CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent | CreateNoWindow;
            if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, environment, worker.OutputDirectory, ref startup, out process))
                throw LastError("CreateProcess AppContainer worker failed");
            return process;
        }
        finally
        {
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (securityCapabilities != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilities);
        }
    }

    private static string BuildCommandLine(RunnerConfig config, WorkerLocation worker)
    {
        if (config.Language == "node") return Quote(worker.ExecutablePath) + " --preserve-symlinks-main " + Quote(worker.ProgramPath);
        if (config.Language == "python") return Quote(worker.ExecutablePath) + " -S " + Quote(worker.ProgramPath);
        if (config.Language == "rscript")
            return Quote(worker.CompatibilityAdapterPath) + " --r-dll " + Quote(worker.CompatibilityRDllPath) + " --script " + Quote(worker.ProgramPath) + " --nt-volume " + Quote(worker.TrustedNtVolume) + " --dos-drive " + Quote(worker.TrustedDosDrive) + " --attestation " + Quote(Path.Combine(worker.OutputDirectory, "r-compatibility.json")) + " --adapter-sha256 " + Quote(worker.CompatibilityAdapterHash) + " --r-dll-sha256 " + Quote(worker.CompatibilityRDllHash);
        throw new InvalidOperationException("Unsupported language");
    }

    private static string BuildEnvironment(RunnerConfig config, WorkerLocation worker)
    {
        List<string> variables = new List<string>();
        string currentDrive = Path.GetPathRoot(worker.OutputDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        variables.Add("=" + currentDrive + "=" + worker.OutputDirectory);
        variables.Add("APPDATA=" + worker.OutputDirectory);
        variables.Add("ComSpec=C:\\Windows\\System32\\cmd.exe");
        variables.Add("HOMEDRIVE=" + currentDrive);
        variables.Add("HOMEPATH=\\");
        variables.Add("HOME=" + worker.OutputDirectory);
        variables.Add("LOCALAPPDATA=" + worker.OutputDirectory);
        variables.Add("PATH=" + worker.RuntimeBinDirectory + ";C:\\Windows\\System32");
        variables.Add("SystemDrive=C:");
        variables.Add("SystemRoot=C:\\Windows");
        variables.Add("TEMP=" + worker.OutputDirectory);
        variables.Add("TMP=" + worker.OutputDirectory);
        variables.Add("TMPDIR=" + worker.OutputDirectory);
        variables.Add("USERPROFILE=" + worker.OutputDirectory);
        variables.Add("windir=C:\\Windows");
        if (config.Language == "python")
        {
            variables.Add("PYTHONHOME=" + worker.RuntimeEnvironmentRoot);
            variables.Add("PYTHONNOUSERSITE=1");
            if (!String.IsNullOrWhiteSpace(worker.PythonSitePackagesDirectory)) variables.Add("PYTHONPATH=" + worker.PythonSitePackagesDirectory);
            if (!String.IsNullOrWhiteSpace(worker.PythonLibraryBinDirectory))
            {
                variables.Remove("PATH=" + worker.RuntimeBinDirectory + ";C:\\Windows\\System32");
                variables.Add("PATH=" + worker.RuntimeBinDirectory + ";" + worker.PythonLibraryBinDirectory + ";C:\\Windows\\System32");
            }
        }
        if (config.Language == "rscript")
        {
            variables.Add("R_HOME=" + worker.RuntimeEnvironmentRoot);
            variables.Add("R_USER=" + worker.OutputDirectory);
            variables.Add("R_COMPAT_PROGRAM=" + worker.ProgramPath);
            if (worker.RLibraryDirectories.Count > 0) variables.Add("R_LIBS=" + String.Join(";", worker.RLibraryDirectories.ToArray()));
        }
        variables.Sort(StringComparer.OrdinalIgnoreCase);
        return String.Join("\0", variables.ToArray()) + "\0\0";
    }

    private static IntPtr AllocateEnvironment(string environment)
    {
        byte[] bytes = Encoding.Unicode.GetBytes(environment);
        IntPtr buffer = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, buffer, bytes.Length);
        return buffer;
    }

    private static string WaitForTerminalState(RunnerConfig config, IntPtr job, IntPtr process, uint rootProcessId, SharedOutputBudget outputBudget, RunnerReceipt receipt, Stopwatch processStopwatch, out string terminalError)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(config.WallTimeMs);
        terminalError = null;
        long lastProgressWriteMilliseconds = 0;
        while (true)
        {
            long elapsedMilliseconds = Math.Max(0, processStopwatch.ElapsedMilliseconds);
            if (elapsedMilliseconds - lastProgressWriteMilliseconds >= RunningReceiptProgressIntervalMilliseconds)
            {
                receipt.WallTimeMs = elapsedMilliseconds;
                receipt.OutputBytes = outputBudget.ReservedBytes;
                WriteReceipt(config.ControlDirectory, "status.json", receipt);
                lastProgressWriteMilliseconds = elapsedMilliseconds;
            }
            uint wait = WaitForSingleObject(process, 50);
            if (wait == 0)
            {
                // A successful root exit cannot authorize detached descendants.  Their output
                // would otherwise race harvesting and escape the run's accounting boundary.
                // Child association can lag the root process signal.  Observe a bounded
                // quiet interval before accepting success, then kill rather than harvest
                // if a distinct live Job member remains.
				if (ObserveJobQuiescence(job, rootProcessId, 500, receipt)) return "exited";
                if (!TerminateJobObject(job, 0xC000041D)) throw LastError("TerminateJobObject residual descendants failed");
                WaitForJobToEmpty(job, 2000);
                terminalError = "Worker root process exited while Job Object descendants remained; residual descendants were terminated.";
                return "failed";
            }
            if (wait != 258) throw LastError("WaitForSingleObject failed");
            if (outputBudget.Exceeded)
            {
                if (!TerminateJobObject(job, 0xC000041D)) throw LastError("TerminateJobObject output-limit failed");
                WaitForJobToEmpty(job, 2000);
                terminalError = "Shared stdout, stderr, and artifact output limit was reached.";
                return "limit-reached";
            }
			if (IsCancelRequested(config))
            {
                if (!TerminateJobObject(job, 0xC000013A)) throw LastError("TerminateJobObject cancel failed");
                WaitForJobToEmpty(job, 2000);
                return "cancelled";
            }
            if (DateTime.UtcNow >= deadline)
            {
                if (!TerminateJobObject(job, 0xC000041D)) throw LastError("TerminateJobObject wall-time failed");
                WaitForJobToEmpty(job, 2000);
                return "limit-reached";
            }
        }
    }

    private static bool WaitForJobToEmpty(IntPtr job, int timeoutMilliseconds)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
        while (true)
        {
            if (!JobHasActiveProcesses(job)) return true;
            if (DateTime.UtcNow >= deadline) return false;
            Thread.Sleep(10);
        }
    }

	private static bool ObserveJobQuiescence(IntPtr job, uint rootProcessId, int quietMilliseconds, RunnerReceipt receipt)
	{
		DateTime deadline = DateTime.UtcNow.AddMilliseconds(quietMilliseconds);
		while (true)
		{
			RootExitObservation observation = CaptureRootExitObservation(job, rootProcessId, receipt.ProcessCreationFileTime);
			RecordRootExitObservation(receipt, observation);
			bool liveJobMember = HasLiveNonRootJobMember(observation);
			bool liveToolhelpDescendant = observation.HasLiveToolhelpDescendant;
			if (DateTime.UtcNow >= deadline) return !liveJobMember && !liveToolhelpDescendant;
            Thread.Sleep(10);
		}
	}

    /**
     * ActiveProcesses remains the authoritative empty check when a Job is being
     * torn down.  It is intentionally not the root-exit success predicate: a
     * signalled root may remain in that aggregate while no Job PID is live.
     */
    private static bool JobHasActiveProcesses(IntPtr job)
    {
		return ReadJobAccounting(job).ActiveProcesses > 0;
    }

	private static bool HasLiveNonRootJobMember(RootExitObservation observation)
	{
		if (!String.IsNullOrWhiteSpace(observation.DiagnosticError)) return true;
		foreach (RootExitJobMember member in observation.JobMembers)
			if (!member.IsRoot && member.Liveness != "exited") return true;
		return false;
	}

	private static BasicAccountingInformation ReadJobAccounting(IntPtr job)
	{
        int size = Marshal.SizeOf(typeof(BasicAccountingInformation));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, 1, buffer, (uint)size, IntPtr.Zero))
                throw LastError("QueryInformationJobObject basic accounting failed");
			return (BasicAccountingInformation)Marshal.PtrToStructure(buffer, typeof(BasicAccountingInformation));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
	}

	/**
	 * Receipt evidence for the root-exit fence.  Job accounting can briefly retain
	 * a root that has already signalled, so the active count alone is not enough to
	 * establish that a distinct descendant remains alive.
	 */
	private static void RecordRootExitObservation(RunnerReceipt receipt, RootExitObservation observation)
	{
		if (receipt.RootExitDiagnostics == null) receipt.RootExitDiagnostics = new List<RootExitObservation>();
		if (receipt.RootExitDiagnostics.Count < 16) receipt.RootExitDiagnostics.Add(observation);
		else receipt.RootExitDiagnostics[receipt.RootExitDiagnostics.Count - 1] = observation;
	}

	private static RootExitObservation CaptureRootExitObservation(IntPtr job, uint rootProcessId, string rootProcessCreationFileTime)
	{
		RootExitObservation observation = new RootExitObservation();
		observation.ObservedAt = DateTime.UtcNow.ToString("O");
		observation.RootProcessId = rootProcessId;
		try
		{
			BasicAccountingInformation accounting = ReadJobAccounting(job);
			observation.TotalProcesses = accounting.TotalProcesses;
			observation.ActiveProcesses = accounting.ActiveProcesses;
			observation.TotalTerminatedProcesses = accounting.TotalTerminatedProcesses;
			Dictionary<uint, ProcessTableEntry> table = SnapshotProcessTable();
			foreach (uint processId in ReadJobProcessIds(job))
				observation.JobMembers.Add(DescribeJobMember(processId, rootProcessId, rootProcessCreationFileTime, table));
			CaptureToolhelpDescendants(observation, table, rootProcessId, rootProcessCreationFileTime);
		}
		catch (Exception error)
		{
			observation.DiagnosticError = error.GetType().Name + ": " + error.Message;
		}
		return observation;
	}

	private static List<uint> ReadJobProcessIds(IntPtr job)
	{
		int headerSize = Marshal.SizeOf(typeof(BasicProcessIdListHeader));
		int capacity = 8;
		while (true)
		{
			IntPtr buffer = Marshal.AllocHGlobal(headerSize + (capacity * IntPtr.Size));
			try
			{
				if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)(headerSize + (capacity * IntPtr.Size)), IntPtr.Zero))
				{
					uint count = unchecked((uint)Marshal.ReadInt32(buffer, sizeof(uint)));
					if (count > capacity) throw new InvalidOperationException("Job process-id list exceeded its returned buffer");
					List<uint> processIds = new List<uint>();
					for (int index = 0; index < count; index++)
						processIds.Add(unchecked((uint)Marshal.ReadIntPtr(buffer, headerSize + (index * IntPtr.Size)).ToInt64()));
					return processIds;
				}
				int error = Marshal.GetLastWin32Error();
				if (error != 234) throw LastError("QueryInformationJobObject basic process-id list failed");
				uint assigned = unchecked((uint)Marshal.ReadInt32(buffer));
				if (assigned > 32768) throw new InvalidOperationException("Job process-id list exceeded its safe diagnostic bound");
				capacity = Math.Max(capacity * 2, (int)Math.Max(assigned, 1));
			}
			finally
			{
				Marshal.FreeHGlobal(buffer);
			}
		}
	}

	private static Dictionary<uint, ProcessTableEntry> SnapshotProcessTable()
	{
		IntPtr snapshot = CreateToolhelp32Snapshot(Th32csSnapProcess, 0);
		if (snapshot == IntPtr.Zero || snapshot == InvalidHandleValue) throw LastError("CreateToolhelp32Snapshot diagnostic failed");
		try
		{
			Dictionary<uint, ProcessTableEntry> processes = new Dictionary<uint, ProcessTableEntry>();
			ProcessEntry32 entry = new ProcessEntry32();
			entry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
			if (!Process32First(snapshot, ref entry))
			{
				int error = Marshal.GetLastWin32Error();
				if (error == 18) return processes;
				throw LastError("Process32First diagnostic failed");
			}
			while (true)
			{
				if (entry.th32ProcessID != 0)
				{
					ProcessTableEntry process = new ProcessTableEntry();
					process.ParentProcessId = entry.th32ParentProcessID;
					process.ImageName = entry.szExeFile;
					processes[entry.th32ProcessID] = process;
				}
				entry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
				if (Process32Next(snapshot, ref entry)) continue;
				int error = Marshal.GetLastWin32Error();
				if (error == 18) break;
				throw LastError("Process32Next diagnostic failed");
			}
			return processes;
		}
		finally { CloseHandle(snapshot); }
	}

	/**
	 * Toolhelp only supplies numeric parent ids, which Windows can reuse after a
	 * process exits.  A parent edge can therefore be diagnostic evidence only
	 * after the candidate is still current, inspectable, and newer than the
	 * immutable root process identity persisted in the receipt.  In particular,
	 * never expand a numeric root PID that currently belongs to another process.
	 */
	private static void CaptureToolhelpDescendants(RootExitObservation observation, Dictionary<uint, ProcessTableEntry> table, uint rootProcessId, string rootProcessCreationFileTime)
	{
		if (String.IsNullOrWhiteSpace(rootProcessCreationFileTime))
			throw new InvalidOperationException("Root process creation identity is missing from the receipt");
		RootExitToolhelpCandidate root = DescribeToolhelpCandidate(rootProcessId, true, table);
		observation.ToolhelpCandidates.Add(root);
		if (root.Liveness != "exited")
		{
			if (!FixedEquals(root.CreationFileTime, rootProcessCreationFileTime))
			{
				root.RejectionReason = "root-identity-mismatch";
				return;
			}
			// WaitForSingleObject has already signalled the root. An inspectable
			// matching root should not be possible, and an uninspectable one does
			// not prove an independent descendant. Job membership remains the
			// fail-closed ownership fence for that case.
			root.RejectionReason = "root-still-present-after-signal";
			return;
		}

		HashSet<uint> known = new HashSet<uint>();
		known.Add(rootProcessId);
		bool expanded = true;
		while (expanded)
		{
			expanded = false;
			foreach (KeyValuePair<uint, ProcessTableEntry> entry in table)
			{
				if (!known.Contains(entry.Value.ParentProcessId) || known.Contains(entry.Key)) continue;
				RootExitToolhelpCandidate candidate = DescribeToolhelpCandidate(entry.Key, false, table);
				observation.ToolhelpCandidates.Add(candidate);
				if (!IsNewerThanRoot(candidate, rootProcessCreationFileTime))
				{
					candidate.RejectionReason = "candidate-not-newer-than-root";
					continue;
				}
				candidate.AcceptedAsDescendant = true;
				known.Add(entry.Key);
				expanded = true;
				if (candidate.Liveness != "exited") observation.HasLiveToolhelpDescendant = true;
			}
		}
	}

	private static bool IsNewerThanRoot(RootExitToolhelpCandidate candidate, string rootProcessCreationFileTime)
	{
		ulong candidateTime;
		ulong rootTime;
		if (!UInt64.TryParse(candidate.CreationFileTime, out candidateTime) || !UInt64.TryParse(rootProcessCreationFileTime, out rootTime)) return false;
		return candidateTime > rootTime;
	}

	private static RootExitToolhelpCandidate DescribeToolhelpCandidate(uint processId, bool isRoot, Dictionary<uint, ProcessTableEntry> table)
	{
		RootExitToolhelpCandidate candidate = new RootExitToolhelpCandidate();
		candidate.ProcessId = processId;
		candidate.IsRoot = isRoot;
		ProcessTableEntry tableEntry;
		if (table.TryGetValue(processId, out tableEntry))
		{
			candidate.ParentProcessId = tableEntry.ParentProcessId;
			candidate.ImageName = tableEntry.ImageName;
		}
		IntPtr process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, processId);
		if (process == IntPtr.Zero)
		{
			int error = Marshal.GetLastWin32Error();
			candidate.Liveness = error == ErrorInvalidParameter ? "exited" : "uninspectable";
			candidate.InspectionError = "OpenProcess:" + error;
			return candidate;
		}
		try
		{
			uint wait = WaitForSingleObject(process, 0);
			candidate.Liveness = wait == 258 ? "alive" : (wait == 0 ? "exited" : "uninspectable");
			if (wait != 0 && wait != 258) candidate.InspectionError = "WaitForSingleObject:" + Marshal.GetLastWin32Error();
			try { candidate.CreationFileTime = GetCreationFileTime(process); }
			catch (Exception error) { candidate.InspectionError = "GetProcessTimes:" + error.GetType().Name; }
			if (String.IsNullOrWhiteSpace(candidate.ImageName)) candidate.ImageName = QueryProcessImageName(process);
			return candidate;
		}
		finally { CloseHandle(process); }
	}

	private static RootExitJobMember DescribeJobMember(uint processId, uint rootProcessId, string rootProcessCreationFileTime, Dictionary<uint, ProcessTableEntry> table)
	{
		RootExitJobMember member = new RootExitJobMember();
		member.ProcessId = processId;
		member.IsRoot = processId == rootProcessId;
		ProcessTableEntry tableEntry;
		if (table.TryGetValue(processId, out tableEntry))
		{
			member.ParentProcessId = tableEntry.ParentProcessId;
			member.ImageName = tableEntry.ImageName;
		}
		if (member.IsRoot)
		{
			member.CreationFileTime = rootProcessCreationFileTime;
			member.Liveness = "exited-root-signaled";
			return member;
		}
		IntPtr process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, processId);
		if (process == IntPtr.Zero)
		{
			int error = Marshal.GetLastWin32Error();
			member.Liveness = error == ErrorInvalidParameter ? "exited" : "uninspectable";
			member.InspectionError = "OpenProcess:" + error;
			return member;
		}
		try
		{
			uint wait = WaitForSingleObject(process, 0);
			member.Liveness = wait == 258 ? "alive" : (wait == 0 ? "exited" : "uninspectable");
			if (wait != 0 && wait != 258) member.InspectionError = "WaitForSingleObject:" + Marshal.GetLastWin32Error();
			try { member.CreationFileTime = GetCreationFileTime(process); }
			catch (Exception error) { member.InspectionError = "GetProcessTimes:" + error.GetType().Name; }
			if (String.IsNullOrWhiteSpace(member.ImageName)) member.ImageName = QueryProcessImageName(process);
			return member;
		}
		finally { CloseHandle(process); }
	}

	private static string QueryProcessImageName(IntPtr process)
	{
		StringBuilder image = new StringBuilder(32768);
		uint length = (uint)image.Capacity;
		if (!QueryFullProcessImageName(process, 0, image, ref length)) return null;
		return image.ToString();
	}

    private static RunnerReceipt NewReceipt(RunnerConfig config, string status)
    {
        RunnerReceipt receipt = new RunnerReceipt();
        receipt.Version = 1;
        receipt.RunId = config.RunId;
        receipt.Status = status;
        receipt.ConfigBindingHash = config.ConfigBindingHash;
        receipt.CancelTokenHash = config.CancelTokenHash;
        receipt.CreatedAt = DateTime.UtcNow.ToString("O");
        return receipt;
    }

    private static bool HasPriorSupervisorReceipt(RunnerConfig config)
    {
        string path = Path.Combine(config.ControlDirectory, "status.json");
        if (!File.Exists(path)) return false;
        RunnerReceipt prior = Deserialize<RunnerReceipt>(File.ReadAllText(path));
        if (prior == null || prior.Version != 1 || prior.RunId != config.RunId || prior.ConfigBindingHash != config.ConfigBindingHash || prior.CancelTokenHash != config.CancelTokenHash)
            throw new InvalidOperationException("Existing runner receipt does not match the immutable configuration");
        if (prior.Status == "succeeded" || prior.Status == "failed" || prior.Status == "cancelled" || prior.Status == "limit-reached") return true;
        // Node writes ProcessId=0 as a durable launch intent. A C# supervisor may
        // replace only that pre-worker receipt. Any positive process identity was
        // persisted before ResumeThread and is a strict no-duplicate fence.
        if (prior.ProcessId <= 0) return false;
        if (ProcessIdentityStillExists(prior.ProcessId, prior.ProcessCreationFileTime)) return true;
        // This invocation acquired the supervisor lock, so no prior supervisor is
        // alive. Its Job handle was configured KILL_ON_JOB_CLOSE; record the
        // unrecoverable launch instead of ever retrying the immutable work.
        prior.Status = "failed";
        prior.Error = "Supervisor recovery found a prior worker receipt without a live matching process; worker was not retried.";
        prior.FinishedAt = DateTime.UtcNow.ToString("O");
        prior.WallTimeMs = Math.Max(0, prior.WallTimeMs);
        WriteReceipt(config.ControlDirectory, "status.json", prior);
        return true;
    }

    private static bool ProcessIdentityStillExists(int processId, string creationFileTime)
    {
        if (processId <= 0 || String.IsNullOrWhiteSpace(creationFileTime)) return false;
        try
        {
            using (Process process = Process.GetProcessById(processId))
            {
                return String.Equals(GetCreationFileTime(process.Handle), creationFileTime, StringComparison.Ordinal);
            }
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (Win32Exception) { return false; }
    }

    private static void WriteReceipt(string controlDirectory, string name, RunnerReceipt receipt)
    {
        AtomicWrite(Path.Combine(controlDirectory, name), Serialize(receipt));
    }

    private static string BindingHash(RunnerConfig config)
    {
        StringBuilder value = new StringBuilder();
        value.Append(config.RunId).Append('|').Append(config.Language).Append('|');
        value.Append(config.RunDirectory).Append('|').Append(config.ControlDirectory).Append('|').Append(config.RuntimeDirectory).Append('|').Append(config.RuntimeBinDirectory).Append('|').Append(config.RuntimeEnvironmentRoot).Append('|').Append(config.InputDirectory).Append('|').Append(config.OutputDirectory).Append('|');
        value.Append(config.ExecutablePath).Append('|').Append(config.ProgramPath).Append('|');
        value.Append(config.MemoryBytes).Append('|').Append(config.CpuRatePercent).Append('|').Append(config.WallTimeMs).Append('|').Append(config.OutputLimitBytes).Append('|').Append(config.CancelTokenHash);
        value.Append('|').Append(config.CompatibilityAdapterPath ?? "").Append('|').Append(config.CompatibilityAdapterHash ?? "");
        value.Append('|').Append(config.CompatibilityRDllPath ?? "").Append('|').Append(config.CompatibilityRDllHash ?? "");
        value.Append('|').Append(config.EnvironmentAdapterKind ?? "").Append('|').Append(config.EnvironmentDescriptorHash ?? "");
        value.Append('|').Append(config.PythonSitePackagesDirectory ?? "").Append('|').Append(config.PythonLibraryBinDirectory ?? "");
        if (config.RLibraryDirectories != null)
            foreach (string libraryDirectory in config.RLibraryDirectories) value.Append('|').Append(libraryDirectory);
        foreach (FileDigest file in config.Files)
            value.Append('|').Append(file.Path).Append('|').Append(file.Sha256);
        return Sha256(value.ToString());
    }

    private static string Quote(string value)
    {
        if (value == null) throw new InvalidOperationException("runner command argument cannot be null");
        if (value.IndexOf('"') >= 0) throw new InvalidOperationException("validated runner paths cannot contain quotes");
        // CreateProcess receives one command-line string.  A trailing backslash
        // in the volume GUID mapping must be doubled or it escapes this closing quote.
        return "\"" + value + (value.EndsWith("\\", StringComparison.Ordinal) ? "\\" : "") + "\"";
    }

    private static string GetCreationFileTime(IntPtr process)
    {
        FileTime creation;
        FileTime exit;
        FileTime kernel;
        FileTime user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw LastError("GetProcessTimes failed");
        ulong value = ((ulong)creation.HighDateTime << 32) | creation.LowDateTime;
        return value.ToString();
    }

    private static T Deserialize<T>(string json)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        return serializer.Deserialize<T>(json);
    }

    private static string Serialize(object value)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        return serializer.Serialize(value);
    }

    private static void AtomicWrite(string path, string content)
    {
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        File.WriteAllText(temporary, content, new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temporary, path, null);
        else File.Move(temporary, path);
    }

    private static string Sha256File(string path)
    {
        using (FileStream stream = File.OpenRead(path))
        using (SHA256 algorithm = SHA256.Create())
            return ToHex(algorithm.ComputeHash(stream));
    }

    private static string Sha256(string value)
    {
        using (SHA256 algorithm = SHA256.Create())
            return ToHex(algorithm.ComputeHash(Encoding.UTF8.GetBytes(value)));
    }

    private static string ToHex(byte[] value)
    {
        StringBuilder hex = new StringBuilder(value.Length * 2);
        foreach (byte item in value) hex.Append(item.ToString("x2"));
        return hex.ToString();
    }

    private static void HarvestWorkerOutput(string workerOutputDirectory, string hostOutputDirectory, SharedOutputBudget outputBudget)
    {
        DirectoryInfo workerRoot = new DirectoryInfo(workerOutputDirectory);
        if (!workerRoot.Exists) throw new DirectoryNotFoundException("AppContainer output directory was not created");
        HarvestWorkerOutputDirectory(workerRoot, workerRoot.FullName, hostOutputDirectory, outputBudget);
    }

    private static void HarvestWorkerOutputDirectory(DirectoryInfo directory, string root, string hostOutputDirectory, SharedOutputBudget outputBudget)
    {
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("AppContainer output reparse points are rejected: " + directory.FullName);
        foreach (FileInfo source in directory.GetFiles())
        {
            if ((source.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("AppContainer output reparse points are rejected: " + source.FullName);
            if (!outputBudget.TryReserve(source.Length))
                throw new OutputLimitExceededException("Shared stdout, stderr, and artifact output exceeds its configured byte limit.");
            string relative = RelativePath(root, source.FullName);
            string destination = Path.Combine(hostOutputDirectory, relative);
            if (File.Exists(destination) || Directory.Exists(destination))
                throw new InvalidOperationException("AppContainer output conflicts with a host output path: " + relative);
            string destinationDirectory = Path.GetDirectoryName(destination);
            if (String.IsNullOrWhiteSpace(destinationDirectory)) throw new InvalidOperationException("AppContainer output has no destination directory");
            Directory.CreateDirectory(destinationDirectory);
            File.Copy(source.FullName, destination, false);
        }
        foreach (DirectoryInfo child in directory.GetDirectories())
            HarvestWorkerOutputDirectory(child, root, hostOutputDirectory, outputBudget);
    }

    private static WorkerOutputSummary MeasureRetainedOutput(string outputDirectory)
    {
        DirectoryInfo root = new DirectoryInfo(outputDirectory);
        WorkerOutputSummary summary = new WorkerOutputSummary();
        if (!root.Exists) return summary;
        MeasureRetainedOutputDirectory(root, summary);
        return summary;
    }

    private static void MeasureRetainedOutputDirectory(DirectoryInfo directory, WorkerOutputSummary summary)
    {
        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Retained output reparse points are rejected: " + directory.FullName);
        foreach (FileInfo file in directory.GetFiles())
        {
            if ((file.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("Retained output reparse points are rejected: " + file.FullName);
            checked { summary.Bytes += file.Length; }
            checked { summary.Files++; }
        }
        foreach (DirectoryInfo child in directory.GetDirectories())
            MeasureRetainedOutputDirectory(child, summary);
    }

    private static bool FixedEquals(string left, string right)
    {
        if (left == null || right == null || left.Length != right.Length) return false;
        int different = 0;
        for (int index = 0; index < left.Length; index++) different |= left[index] ^ right[index];
        return different == 0;
    }

    private static bool IsExecutionHash(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length != 71 || !value.StartsWith("sha256:", StringComparison.Ordinal)) return false;
        for (int index = 7; index < value.Length; index++)
        {
            char character = value[index];
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
        }
        return true;
    }

	private static bool IsSha256Digest(string value)
	{
		if (String.IsNullOrWhiteSpace(value) || value.Length != 64) return false;
		for (int index = 0; index < value.Length; index++)
		{
			char character = value[index];
			if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
		}
		return true;
	}

    private static Win32Exception LastError(string message)
    {
        int error = Marshal.GetLastWin32Error();
        return new Win32Exception(error, message + " (Win32 error " + error + ": " + new Win32Exception(error).Message + ")");
    }

    private sealed class RunnerConfig
    {
        public int Version { get; set; }
        public string RunId { get; set; }
        public string Language { get; set; }
        public string RunDirectory { get; set; }
        public string ControlDirectory { get; set; }
        public string RuntimeDirectory { get; set; }
        public string RuntimeBinDirectory { get; set; }
        public string RuntimeEnvironmentRoot { get; set; }
        public string InputDirectory { get; set; }
        public string OutputDirectory { get; set; }
        public string ExecutablePath { get; set; }
        public string ProgramPath { get; set; }
        public long MemoryBytes { get; set; }
        public int CpuRatePercent { get; set; }
        public int WallTimeMs { get; set; }
        public int OutputLimitBytes { get; set; }
        public string CancelTokenHash { get; set; }
        public string ConfigBindingHash { get; set; }
        public string CompatibilityAdapterPath { get; set; }
        public string CompatibilityAdapterHash { get; set; }
        public string CompatibilityRDllPath { get; set; }
        public string CompatibilityRDllHash { get; set; }
        public string EnvironmentAdapterKind { get; set; }
        public string EnvironmentDescriptorHash { get; set; }
        public string PythonSitePackagesDirectory { get; set; }
        public string PythonLibraryBinDirectory { get; set; }
        public List<string> RLibraryDirectories { get; set; }
        public List<FileDigest> Files { get; set; }
    }

    private sealed class FileDigest
    {
        public string Path { get; set; }
        public string Sha256 { get; set; }
    }

    private sealed class LaunchClaim
    {
        public string RunId { get; set; }
        public string ConfigBindingHash { get; set; }
        public string Disposition { get; set; }
    }

    private sealed class CancelRequest
    {
        public int Version { get; set; }
        public string RunId { get; set; }
        public string ConfigBindingHash { get; set; }
        public string CancelTokenHash { get; set; }
    }

    private sealed class RunnerReceipt
    {
        public int Version { get; set; }
        public string RunId { get; set; }
        public string Status { get; set; }
        public string ConfigBindingHash { get; set; }
        public string CancelTokenHash { get; set; }
        public int ProcessId { get; set; }
        public string ProcessCreationFileTime { get; set; }
        public uint ExitCode { get; set; }
        public string CreatedAt { get; set; }
        public string StartedAt { get; set; }
        public string FinishedAt { get; set; }
        public string Error { get; set; }
        public string AppContainerCleanup { get; set; }
        public long StdoutBytes { get; set; }
        public long StderrBytes { get; set; }
        public bool StdoutTruncated { get; set; }
        public bool StderrTruncated { get; set; }
        public long OutputBytes { get; set; }
        public int OutputFiles { get; set; }
        public long WallTimeMs { get; set; }
		public List<RootExitObservation> RootExitDiagnostics { get; set; }
    }

	private sealed class RootExitObservation
	{
		public string ObservedAt { get; set; }
		public uint RootProcessId { get; set; }
		public uint TotalProcesses { get; set; }
		public uint ActiveProcesses { get; set; }
		public uint TotalTerminatedProcesses { get; set; }
		public List<RootExitJobMember> JobMembers { get; set; }
		public List<RootExitToolhelpCandidate> ToolhelpCandidates { get; set; }
		public bool HasLiveToolhelpDescendant { get; set; }
		public string DiagnosticError { get; set; }

		public RootExitObservation()
		{
			JobMembers = new List<RootExitJobMember>();
			ToolhelpCandidates = new List<RootExitToolhelpCandidate>();
		}
	}

	private sealed class RootExitJobMember
	{
		public uint ProcessId { get; set; }
		public bool IsRoot { get; set; }
		public uint ParentProcessId { get; set; }
		public string ImageName { get; set; }
		public string CreationFileTime { get; set; }
		public string Liveness { get; set; }
		public string InspectionError { get; set; }
	}

	private sealed class RootExitToolhelpCandidate
	{
		public uint ProcessId { get; set; }
		public bool IsRoot { get; set; }
		public uint ParentProcessId { get; set; }
		public string ImageName { get; set; }
		public string CreationFileTime { get; set; }
		public string Liveness { get; set; }
		public bool AcceptedAsDescendant { get; set; }
		public string RejectionReason { get; set; }
		public string InspectionError { get; set; }
	}

	private sealed class ProcessTableEntry
	{
		public uint ParentProcessId;
		public string ImageName;
	}

    private sealed class WorkerOutputSummary
    {
        public long Bytes;
        public int Files;
    }

    private sealed class OutputLimitExceededException : Exception
    {
        public OutputLimitExceededException(string message) : base(message) { }
    }

    /** One synchronized reservation covers stdout, stderr, and harvested result files. */
    private sealed class SharedOutputBudget
    {
        private readonly long maximumBytes;
        private long reservedBytes;
        private bool exceeded;
        private readonly object gate = new object();

        public SharedOutputBudget(long maximumBytes)
        {
            if (maximumBytes < 1) throw new ArgumentOutOfRangeException("maximumBytes");
            this.maximumBytes = maximumBytes;
        }

        public bool Exceeded
        {
            get { lock (gate) return exceeded; }
        }

        public long ReservedBytes
        {
            get { lock (gate) return reservedBytes; }
        }

        public int ReserveUpTo(int requestedBytes)
        {
            if (requestedBytes < 0) throw new ArgumentOutOfRangeException("requestedBytes");
            lock (gate)
            {
                long remaining = Math.Max(0, maximumBytes - reservedBytes);
                int granted = (int)Math.Min((long)requestedBytes, remaining);
                reservedBytes += granted;
                if (granted < requestedBytes) exceeded = true;
                return granted;
            }
        }

        public bool TryReserve(long requestedBytes)
        {
            if (requestedBytes < 0) throw new ArgumentOutOfRangeException("requestedBytes");
            lock (gate)
            {
                if (requestedBytes > maximumBytes - reservedBytes)
                {
                    exceeded = true;
                    return false;
                }
                reservedBytes += requestedBytes;
                return true;
            }
        }
    }

    private sealed class BoundedCapture
    {
        private readonly IntPtr handle;
        private readonly string outputPath;
        private readonly SharedOutputBudget outputBudget;
        private Thread thread;
        public long WrittenBytes { get; private set; }
        public bool Truncated { get; private set; }

        public BoundedCapture(IntPtr handle, string outputPath, SharedOutputBudget outputBudget)
        {
            this.handle = handle;
            this.outputPath = outputPath;
            this.outputBudget = outputBudget;
        }

        public void Start()
        {
            thread = new Thread(ReadLoop);
            thread.IsBackground = true;
            thread.Start();
        }

        public void Join()
        {
            if (thread != null) thread.Join(3000);
        }

        private void ReadLoop()
        {
            using (FileStream input = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read))
            using (FileStream output = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.Read))
            {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    int writable = outputBudget.ReserveUpTo(read);
                    if (writable > 0)
                    {
                        output.Write(buffer, 0, writable);
                        WrittenBytes += writable;
                        output.Flush();
                    }
                    if (writable < read) Truncated = true;
                }
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public int CapabilityCount;
        public int Reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
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
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

	[StructLayout(LayoutKind.Sequential)]
	private struct BasicProcessIdListHeader
	{
		public uint NumberOfAssignedProcesses;
		public uint NumberOfProcessIdsInList;
	}

	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	private struct ProcessEntry32
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
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
		public string szExeFile;
	}

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CpuRateControlInformation
    {
        public uint ControlFlags;
        public uint CpuRate;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint LowDateTime;
        public uint HighDateTime;
    }

    private sealed class ChildPipes
    {
        public IntPtr StandardInputRead;
        public IntPtr StandardInputWrite;
        public IntPtr StandardOutputRead;
        public IntPtr StandardOutputWrite;
        public IntPtr StandardErrorRead;
        public IntPtr StandardErrorWrite;
    }

    private sealed class WorkerLocation
    {
        public string WorkspaceDirectory;
        public string RuntimeDirectory;
        public string RuntimeBinDirectory;
        public string RuntimeEnvironmentRoot;
        public string InputDirectory;
        public string OutputDirectory;
        public string ExecutablePath;
        public string ProgramPath;
        public string CompatibilityAdapterPath;
        public string CompatibilityAdapterHash;
        public string CompatibilityRDllPath;
        public string CompatibilityRDllHash;
        public string PythonSitePackagesDirectory;
        public string PythonLibraryBinDirectory;
        public List<string> RLibraryDirectories = new List<string>();
        public string TrustedDosDrive;
        public string TrustedNtVolume;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, int capabilityCount, out IntPtr appContainerSid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetAppContainerFolderPath(string appContainerSid, out IntPtr path);
    [DllImport("ole32.dll")]
    private static extern void CoTaskMemFree(IntPtr memory);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint pathCount, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, IntPtr returnLength);
	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder executablePath, ref uint size);
	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SecurityAttributes attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int attributeCount, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
}
