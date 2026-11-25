using ShowMe.Core.Playback;

namespace ShowMe.Core.Tests;

/// <summary>Port of test/player.test.ts.</summary>
public class PlayerTests
{
    /// <summary>
    /// Fake engine: each step has <c>clipsPerStep</c> clips that synthesize instantly; each clip
    /// "plays" for 1000 ms of fake time. Pause freezes the remaining play time like SIGSTOP would.
    /// </summary>
    private sealed class Rig : INarrator, IAudioOut, IPlayerHost, IDisposable
    {
        private readonly int _clipsPerStep;
        private readonly bool _autoAdvance;
        private readonly int _gap;
        private Clip? _current;
        private bool _paused;

        private sealed class Clip
        {
            public string File = "";
            public long Remaining;
            public long StartedAt;
            public int? Timer;
            public TaskCompletionSource<bool> Done = new();
        }

        public Rig(int total = 3, int clipsPerStep = 2, bool autoAdvance = true, int gap = 100)
        {
            Total = total;
            _clipsPerStep = clipsPerStep;
            _autoAdvance = autoAdvance;
            _gap = gap;
            Time = FakeTime.Use();
            Player = new Player(this, this, this, Time.Delay);
        }

        public FakeTime Time { get; }
        public Player Player { get; }
        public int Total { get; }
        public List<string> Log { get; } = new();
        public List<List<int>> Prefetches { get; } = new();

        public IReadOnlyList<Task<string>> Clips(int index) =>
            Enumerable.Range(0, _clipsPerStep).Select(c => Task.FromResult($"s{index}c{c}")).ToList();

        public void Prefetch(IReadOnlyList<int> indices) => Prefetches.Add(indices.ToList());
        public int SilentDurationMs(int index) => 500;

        public Task Play(string file)
        {
            Log.Add($"play {file}");
            var clip = new Clip { File = file, Remaining = 1000 };
            _current = clip;
            if (!_paused) StartTimer();
            return clip.Done.Task;
        }

        private void StartTimer()
        {
            var c = _current;
            if (c == null) return;
            c.StartedAt = Time.Now;
            c.Timer = Time.SetTimeout(c.Remaining, () =>
            {
                Log.Add($"end {c.File}");
                _current = null;
                c.Done.TrySetResult(true);
            });
        }

        public void Pause()
        {
            _paused = true;
            if (_current is { Timer: { } t } c)
            {
                Time.ClearTimeout(t);
                c.Remaining -= Time.Now - c.StartedAt;
                c.Timer = null;
            }
        }

        public void Resume()
        {
            _paused = false;
            if (_current is { Timer: null }) StartTimer();
        }

        public void Stop()
        {
            _paused = false;
            if (_current is { } c)
            {
                if (c.Timer is { } t) Time.ClearTimeout(t);
                Log.Add($"stop {c.File}");
                _current = null;
                c.Done.TrySetResult(true);
            }
        }

        public Task Present(int index)
        {
            Log.Add($"present {index}");
            return Task.CompletedTask;
        }

        public void Changed() { }
        public PlayerOptions Options() => new() { AutoAdvance = _autoAdvance, PauseBetweenStepsMs = _gap };
        public void Error(Exception error, int index) => Log.Add($"error {error.Message}");

        public void Dispose() => Time.Dispose();
    }

    [Fact]
    public void PlaysEveryClipOfEveryStepInOrderThenFinishes()
    {
        using var r = new Rig();
        r.Player.Start(r.Total);
        r.Time.RunAll();
        Assert.Equal(new[]
        {
            "present 0", "play s0c0", "end s0c0", "play s0c1", "end s0c1",
            "present 1", "play s1c0", "end s1c0", "play s1c1", "end s1c1",
            "present 2", "play s2c0", "end s2c0", "play s2c1", "end s2c1",
        }, r.Log);
        Assert.Equal(PlayerState.Finished, r.Player.State);
        Assert.Equal(2, r.Player.Index);
    }

    [Fact]
    public void PrefetchesTheCurrentStepFirstThenTheRest()
    {
        using var r = new Rig();
        r.Player.Start(r.Total);
        r.Time.Advance(10);
        Assert.Equal(new[] { 0, 1, 2 }, r.Prefetches[0]);
    }

    [Fact]
    public void PausesMidClipAndResumesWhereItLeftOff()
    {
        using var r = new Rig(total: 1, clipsPerStep: 1);
        r.Player.Start(r.Total);
        r.Time.Advance(400);
        r.Player.TogglePause();
        Assert.Equal(PlayerState.Paused, r.Player.State);
        r.Time.Advance(5000);
        Assert.DoesNotContain("end s0c0", r.Log);
        r.Player.TogglePause();
        Assert.Equal(PlayerState.Playing, r.Player.State);
        r.Time.Advance(599);
        Assert.DoesNotContain("end s0c0", r.Log);
        r.Time.Advance(2);
        Assert.Contains("end s0c0", r.Log);
        Assert.Equal(PlayerState.Finished, r.Player.State);
    }

    [Fact]
    public void DoesNotStartTheNextClipWhilePausedBetweenClips()
    {
        using var r = new Rig(total: 1, clipsPerStep: 2);
        r.Player.Start(r.Total);
        r.Time.Advance(1000); // first clip ends
        r.Player.Pause();
        r.Time.Advance(5000);
        Assert.Equal(new[] { "play s0c0", "play s0c1" }, r.Log.Where(l => l.StartsWith("play")));
        Assert.DoesNotContain("end s0c1", r.Log); // spawned, but frozen
        r.Player.Resume();
        r.Time.RunAll();
        Assert.Contains("end s0c1", r.Log);
    }

    [Fact]
    public void NextAndPreviousInterruptTheCurrentNarration()
    {
        using var r = new Rig();
        r.Player.Start(r.Total);
        r.Time.Advance(300);
        r.Player.Next();
        r.Time.Advance(10);
        Assert.Equal(new[] { "present 0", "play s0c0", "stop s0c0", "present 1", "play s1c0" }, r.Log);
        r.Player.Previous();
        r.Time.Advance(10);
        Assert.Equal(0, r.Player.Index);
        Assert.Equal(new[] { "stop s1c0", "present 0", "play s0c0" }, r.Log.Skip(r.Log.Count - 3));
    }

    [Fact]
    public void NextOnTheLastStepFinishesTheTour()
    {
        using var r = new Rig();
        r.Player.Start(r.Total, 2);
        r.Time.Advance(10);
        r.Player.Next();
        Assert.Equal(PlayerState.Finished, r.Player.State);
    }

    [Fact]
    public void WaitsForTheUserWhenAutoAdvanceIsOff()
    {
        using var r = new Rig(autoAdvance: false);
        r.Player.Start(r.Total);
        r.Time.RunAll();
        Assert.Equal(PlayerState.Waiting, r.Player.State);
        Assert.DoesNotContain("present 1", r.Log);
        r.Player.TogglePause(); // acts as "next" while waiting
        r.Time.Advance(10);
        Assert.Contains("present 1", r.Log);
    }

    [Fact]
    public void HonoursThePauseBetweenSteps()
    {
        using var r = new Rig(clipsPerStep: 1, gap: 2000);
        r.Player.Start(r.Total);
        r.Time.Advance(1000 + 1999);
        Assert.DoesNotContain("present 1", r.Log);
        r.Time.Advance(2);
        Assert.Contains("present 1", r.Log);
    }

    [Fact]
    public void StopHaltsEverythingAndResets()
    {
        using var r = new Rig();
        r.Player.Start(r.Total);
        r.Time.Advance(300);
        r.Player.Stop();
        r.Time.RunAll();
        Assert.Equal(PlayerState.Idle, r.Player.State);
        Assert.Equal(new[] { "present 0", "play s0c0", "stop s0c0" }, r.Log);
    }

    [Fact]
    public void TogglePauseOnAFinishedTourRestartsIt()
    {
        using var r = new Rig(total: 1, clipsPerStep: 1);
        r.Player.Start(r.Total);
        r.Time.RunAll();
        r.Player.TogglePause();
        r.Time.Advance(10);
        Assert.Equal(2, r.Log.Count(l => l == "present 0"));
    }

    [Fact]
    public void CaptionsOnlyStepsWaitForTheReadingTime()
    {
        using var r = new Rig(total: 2, clipsPerStep: 0, gap: 0);
        r.Player.Start(r.Total);
        r.Time.Advance(499);
        Assert.DoesNotContain("present 1", r.Log);
        r.Time.Advance(2);
        Assert.Contains("present 1", r.Log);
    }
}
