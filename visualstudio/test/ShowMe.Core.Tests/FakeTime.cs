namespace ShowMe.Core.Tests;

/// <summary>
/// Deterministic time and continuations for async state-machine tests, like vitest's fake timers.
/// Install it with <see cref="Use"/>; every await then resumes on this thread, and only when the
/// test advances time.
/// </summary>
internal sealed class FakeTime : SynchronizationContext, IDisposable
{
    private readonly Queue<(SendOrPostCallback Callback, object? State)> _posted = new();
    private readonly List<(long Due, int Id, Action Action)> _timers = new();
    private readonly SynchronizationContext? _previous;
    private int _nextId;

    private FakeTime()
    {
        _previous = Current;
        SetSynchronizationContext(this);
    }

    public static FakeTime Use() => new();

    public long Now { get; private set; }

    public override void Post(SendOrPostCallback d, object? state) => _posted.Enqueue((d, state));

    public override void Send(SendOrPostCallback d, object? state) => d(state);

    public int SetTimeout(long ms, Action action)
    {
        int id = ++_nextId;
        _timers.Add((Now + Math.Max(0, ms), id, action));
        return id;
    }

    public void ClearTimeout(int id) => _timers.RemoveAll(t => t.Id == id);

    public Task Delay(int ms)
    {
        var tcs = new TaskCompletionSource<bool>();
        SetTimeout(ms, () => tcs.TrySetResult(true));
        return tcs.Task;
    }

    /// <summary>Runs queued continuations until nothing is left to do right now.</summary>
    public void Drain()
    {
        for (int guard = 0; _posted.Count > 0; guard++)
        {
            if (guard > 100_000) throw new InvalidOperationException("continuations never settle");
            var (callback, state) = _posted.Dequeue();
            callback(state);
        }
    }

    /// <summary>Moves time forward, firing due timers in order and draining after each.</summary>
    public void Advance(long ms)
    {
        long target = Now + ms;
        Drain();
        while (true)
        {
            var due = _timers.Where(t => t.Due <= target).OrderBy(t => t.Due).ThenBy(t => t.Id).ToList();
            if (due.Count == 0) break;
            var next = due[0];
            _timers.Remove(next);
            Now = next.Due;
            next.Action();
            Drain();
        }
        Now = target;
    }

    /// <summary>Fires every timer, including ones scheduled while running, like vi.runAllTimersAsync.</summary>
    public void RunAll()
    {
        Drain();
        for (int guard = 0; _timers.Count > 0; guard++)
        {
            if (guard > 10_000) throw new InvalidOperationException("timers never settle");
            var next = _timers.OrderBy(t => t.Due).ThenBy(t => t.Id).First();
            _timers.Remove(next);
            Now = Math.Max(Now, next.Due);
            next.Action();
            Drain();
        }
    }

    public void Dispose() => SetSynchronizationContext(_previous);
}
