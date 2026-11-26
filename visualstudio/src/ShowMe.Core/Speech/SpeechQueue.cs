using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace ShowMe.Core.Speech;

/// <summary>A clip that was dropped from the queue before it was synthesized.</summary>
public sealed class CancelledException : OperationCanceledException
{
    public CancelledException() : base("cancelled") { }
}

/// <summary>
/// Serial synthesis queue with de-duplication and re-prioritisation. Port of
/// src/tts/speechQueue.ts.
///
/// The Kokoro helper synthesizes one clip at a time. When the user jumps to another step we
/// reorder pending work so the clips needed next are generated first, and drop clips that are
/// no longer needed. Not thread-safe: use it from one thread (the UI thread in Visual Studio).
/// </summary>
public sealed class SpeechQueue
{
    private sealed class Job
    {
        public Job(string key, string text)
        {
            Key = key;
            Text = text;
        }

        public string Key { get; }
        public string Text { get; }
        public TaskCompletionSource<string> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private readonly Func<string, string, Task<string>> _synthesize;
    private readonly Dictionary<string, string> _done = new();
    private readonly Dictionary<string, Job> _jobs = new();
    private List<Job> _pending = new();
    private Job? _running;

    public SpeechQueue(Func<string, string, Task<string>> synthesize) => _synthesize = synthesize;

    /// <summary>The clip file for <paramref name="key"/>, synthesizing it if needed.</summary>
    public Task<string> Request(string key, string text)
    {
        if (_done.TryGetValue(key, out var finished)) return Task.FromResult(finished);
        if (_jobs.TryGetValue(key, out var existing)) return existing.Completion.Task;

        var job = new Job(key, text);
        _jobs[key] = job;
        _pending.Add(job);
        Pump();
        return job.Completion.Task;
    }

    /// <summary>
    /// Keeps only pending jobs whose key is in <paramref name="keysInOrder"/>, ordered as given.
    /// The job being synthesized always finishes.
    /// </summary>
    public void Prioritize(IReadOnlyList<string> keysInOrder)
    {
        var rank = new Dictionary<string, int>();
        for (int i = 0; i < keysInOrder.Count; i++)
        {
            if (!rank.ContainsKey(keysInOrder[i])) rank[keysInOrder[i]] = i;
        }
        var keep = new List<Job>();
        foreach (var job in _pending)
        {
            if (rank.ContainsKey(job.Key))
            {
                keep.Add(job);
            }
            else
            {
                _jobs.Remove(job.Key);
                job.Completion.TrySetException(new CancelledException());
            }
        }
        _pending = keep.OrderBy(j => rank[j.Key]).ToList();
    }

    /// <summary>Drops all pending work (the running job still completes).</summary>
    public void Clear() => Prioritize(Array.Empty<string>());

    /// <summary>Forgets finished results (e.g. after the voice setting changed).</summary>
    public void Reset()
    {
        Clear();
        _done.Clear();
    }

    public int PendingCount => _pending.Count;

    private void Pump()
    {
        if (_running != null || _pending.Count == 0) return;
        var job = _pending[0];
        _pending.RemoveAt(0);
        _running = job;
        _ = RunAsync(job);
    }

    private async Task RunAsync(Job job)
    {
        try
        {
            var file = await _synthesize(job.Key, job.Text);
            _done[job.Key] = file;
            job.Completion.TrySetResult(file);
        }
        catch (Exception ex)
        {
            job.Completion.TrySetException(ex);
        }
        finally
        {
            _jobs.Remove(job.Key);
            _running = null;
            Pump();
        }
    }
}
