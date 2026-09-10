// Minimal Windows verification host.
//
// The core gives this helper an executable and an already-tokenized argument
// list.  The helper deliberately does not invoke a shell.  A Job Object owns
// the complete descendant tree, so closing the host also terminates children
// that outlive the direct process.
#ifdef _WIN32
#include <windows.h>
#include <cwchar>
#include <string>
#include <vector>

// Reserved status returned by the helper when it cannot prove that every
// process in the Job Object has exited.  The core treats this as an unknown
// execution boundary rather than as the command's exit code.
static constexpr DWORD kTreeCleanupUnconfirmed = 0xE0000001u;

static bool queryActiveProcesses(HANDLE job, DWORD* active) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  if (!QueryInformationJobObject(
          job,
          JobObjectBasicAccountingInformation,
          &accounting,
          sizeof(accounting),
          nullptr)) {
    return false;
  }
  *active = accounting.ActiveProcesses;
  return true;
}

static bool waitForJobEmpty(HANDLE job, DWORD timeoutMs) {
  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  while (true) {
    DWORD active = 0;
    if (!queryActiveProcesses(job, &active)) return false;
    if (active == 0) return true;
    if (GetTickCount64() >= deadline) return false;
    Sleep(10);
  }
}

static std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t ch : value) {
    if (ch == L'\\') {
      ++backslashes;
      continue;
    }
    if (ch == L'\"') {
      // Backslashes immediately before a quote are escape characters in the
      // Windows command-line grammar, so double them and escape the quote.
      result.append(backslashes * 2 + 1, L'\\');
      result += L'\"';
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result += ch;
  }
  // Backslashes before the closing quote must also be doubled.
  result.append(backslashes * 2, L'\\');
  result += L"\"";
  return result;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return ERROR_INVALID_PARAMETER;
  // The core passes its PID so the helper can close the Job Object when the
  // supervising process disappears unexpectedly.  The legacy argv[1] form is
  // still accepted for the standalone packaged smoke test.
  DWORD parentPid = 0;
  int commandIndex = 1;
  if (argc >= 5 && std::wstring(argv[1]) == L"--parent-pid" &&
      std::wstring(argv[3]) == L"--") {
    wchar_t* end = nullptr;
    unsigned long parsed = std::wcstoul(argv[2], &end, 10);
    if (!end || *end != L'\0' || parsed == 0 || parsed > MAXDWORD) {
      return ERROR_INVALID_PARAMETER;
    }
    parentPid = static_cast<DWORD>(parsed);
    commandIndex = 4;
  }
  if (argc <= commandIndex) return ERROR_INVALID_PARAMETER;
  HANDLE parent = nullptr;
  if (parentPid != 0) {
    parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (!parent) return static_cast<int>(GetLastError());
  }
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    if (parent) CloseHandle(parent);
    return static_cast<int>(GetLastError());
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    CloseHandle(job);
    if (parent) CloseHandle(parent);
    return static_cast<int>(GetLastError());
  }
  std::wstring command = quote(argv[commandIndex]);
  for (int i = commandIndex + 1; i < argc; ++i) {
    command += L" ";
    command += quote(argv[i]);
  }
  std::vector<wchar_t> commandLine(command.begin(), command.end());
  commandLine.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  // Node supplies inheritable pipe handles for the helper's standard streams.
  // Pass those handles through to the suspended verification child so the
  // core can continue draining output while the Job Object owns descendants.
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
  if (!CreateProcessW(argv[commandIndex], commandLine.data(), nullptr, nullptr, TRUE, flags,
                      nullptr, nullptr, &startup, &process)) {
    const DWORD error = GetLastError();
    CloseHandle(job);
    if (parent) CloseHandle(parent);
    return static_cast<int>(error);
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, ERROR_ACCESS_DENIED);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    if (parent) CloseHandle(parent);
    return static_cast<int>(GetLastError());
  }
  ResumeThread(process.hThread);
  HANDLE waits[2] = {process.hProcess, parent};
  const DWORD waitCount = parent ? 2 : 1;
  const DWORD waitResult = WaitForMultipleObjects(waitCount, waits, FALSE, INFINITE);
  DWORD exitCode = 1;
  if (waitResult == WAIT_OBJECT_0) {
    DWORD childExitCode = 1;
    GetExitCodeProcess(process.hProcess, &childExitCode);
    // The child and supervisor can become signaled at the same time. Since
    // WaitForMultipleObjects returns the lowest index in that case, inspect
    // the parent handle again before accepting the child's exit code; a
    // supervisor that disappeared must always take the cleanup/abort path.
    if (parent && WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) {
      const bool terminated = TerminateJobObject(job, ERROR_PROCESS_ABORTED) != FALSE;
      exitCode = terminated && waitForJobEmpty(job, 2'000)
        ? ERROR_PROCESS_ABORTED
        : kTreeCleanupUnconfirmed;
    } else {
      // A direct child can exit while a descendant remains in the Job Object.
      // Give the kernel a short observation window, then terminate the whole
      // tree and require a second, bounded observation to prove cleanup.  A
      // descendant leak is reported as an unconfirmed boundary even if the
      // forced cleanup eventually succeeds; otherwise a parent-only exit could
      // be mistaken for a clean verification result.
      DWORD active = 0;
      const bool initiallyEmpty = queryActiveProcesses(job, &active) && active == 0;
      if (!initiallyEmpty) {
        const bool terminated = TerminateJobObject(job, ERROR_PROCESS_ABORTED) != FALSE;
        const bool cleaned = terminated && waitForJobEmpty(job, 2'000);
        (void)cleaned;
        exitCode = kTreeCleanupUnconfirmed;
      } else {
        exitCode = childExitCode;
      }
    }
  } else if (parent && waitResult == WAIT_OBJECT_0 + 1) {
    // Closing the job is the final cleanup authority. Explicitly terminate
    // first so descendants are gone before the helper exits even if the
    // kernel delays the KILL_ON_JOB_CLOSE notification.
    const bool terminated = TerminateJobObject(job, ERROR_PROCESS_ABORTED) != FALSE;
    // A broken Job Object or a process that refuses to terminate must not
    // leave the helper hanging forever after its supervisor disappeared.
    // Treat an unobserved exit as the same unknown boundary as a leaked
    // descendant and return the reserved status below.
    DWORD processWait = WaitForSingleObject(process.hProcess, 2'000);
    if (processWait != WAIT_OBJECT_0) {
      TerminateProcess(process.hProcess, ERROR_PROCESS_ABORTED);
      processWait = WaitForSingleObject(process.hProcess, 2'000);
    }
    // The supervisor disappeared before a command result could be committed.
    // Even when the Job is successfully drained, the command outcome is
    // unknown to the core and must be classified as an unclean boundary.
    (void)terminated;
    (void)processWait;
    (void)waitForJobEmpty(job, 2'000);
    exitCode = kTreeCleanupUnconfirmed;
  } else {
    const bool terminated = TerminateJobObject(job, ERROR_PROCESS_ABORTED) != FALSE;
    exitCode = terminated && waitForJobEmpty(job, 2'000)
      ? ERROR_PROCESS_ABORTED
      : kTreeCleanupUnconfirmed;
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (parent) CloseHandle(parent);
  CloseHandle(job);
  return static_cast<int>(exitCode);
}
#else
int main() { return 3; }
#endif
