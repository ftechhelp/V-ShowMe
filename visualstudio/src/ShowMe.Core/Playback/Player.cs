using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace ShowMe.Core.Playback;

public enum PlayerState
{
    Idle,
    Playing,
    Paused,
    Waiting,
    Finished,
}

public interface INarrator
{
    /// <summary>Clip files for a step, in speaking order. Empty means captions only.</summary>
    IReadOnlyList<Task<string>> Clips(int index);

    /// <summary>Steps that will be needed soon, most urgent first.</summary>
    void Prefetch(IReadOnlyList<int> indices);

    /// <summary>How long to stay on a step when there is no audio.</summary>
    int SilentDurationMs(int index);
}

public interface IAudioOut
{
    /// <summary>Completes when the clip finished playing or was stopped. Never faults.</summary>
    Task Play(string file);

    void Pause();
    void Resume();
    void Stop();
}

public sealed class PlayerOptions
{
    public bool AutoAdvance { get; set; } = true;
    public int PauseBetweenStepsMs { get; set; } = 600;
}

public interface IPlayerHost
{
    /// <summary>Show step <paramref name="index"/> in the editor (open file, highlight, caption).</summary>
    Task Present(int index);

    /// <summary>State or step changed.</summary>
    void Changed();

    PlayerOptions Options();
    void Error(Exception error, int index);
}

/// <summary>
/// Tour playback state machine. Port of src/player/player.ts.
///
///   idle ──start──▶ playing ──pause──▶ paused ──resume──▶ playing
///                     │  ▲                                   │
///                     │  └──────── next / previous / goto ───┘
///                     ├─ narration done, autoAdvance off ──▶ waiting ──next──▶ playing
///                     └─ last step done ──────────────────▶ finished
///
/// Not thread-safe. Call it from one thread that has a SynchronizationContext (the Visual Studio
/// UI thread), so that its awaits resume on that thread.
/// </summary>
public sealed class Player
{
    private readonly INarrator _narrator;
    private readonly IAudioOut _audio;
    private readonly IPlayerHost _host;
    private readonly Func<int, Task> _delay;
    private readonly Gate _gate = new();
    private int _generation;

    public Player(INarrator narrator, IAudioOut audio, IPlayerHost host, Func<int, Task>? delay = null)
    {
        _narrator = narrator;
        _audio = audio;
        _host = host;
        _delay = delay ?? (ms => Task.Delay(ms));
    }

    public PlayerState State { get; private set; } = PlayerState.Idle;
    public int Index { get; private set; }
    public int Total { get; private set; }

    public void Start(int total, int index = 0)
    {
        Total = total;
        Goto(index);
    }

    public void Goto(int index)
    {
        if (Total == 0) return;
        int target = Math.Min(Math.Max(index, 0), Total - 1);
        int gen = ++_generation;
        _audio.Stop();
        _gate.Open();
        Index = target;
        SetState(PlayerState.Playing);
        _ = Run(target, gen);
    }

    public void Next()
    {
        if (State == PlayerState.Idle) return;
        if (Index < Total - 1)
        {
            Goto(Index + 1);
        }
        else
        {
            _generation++;
            _audio.Stop();
            _gate.Open();
            SetState(PlayerState.Finished);
        }
    }

    public void Previous()
    {
        if (State == PlayerState.Idle) return;
        Goto(Index - 1);
    }

    public void Replay()
    {
        if (State == PlayerState.Idle) return;
        Goto(Index);
    }

    public void TogglePause()
    {
        switch (State)
        {
            case PlayerState.Playing: Pause(); break;
            case PlayerState.Paused: Resume(); break;
            case PlayerState.Waiting: Next(); break;
            case PlayerState.Finished: Goto(0); break;
        }
    }

    public void Pause()
    {
        if (State != PlayerState.Playing) return;
        _gate.Close();
        _audio.Pause();
        SetState(PlayerState.Paused);
    }

    public void Resume()
    {
        if (State != PlayerState.Paused) return;
        _gate.Open();
        _audio.Resume();
        SetState(PlayerState.Playing);
    }

    public void Stop()
    {
        _generation++;
        _audio.Stop();
        _gate.Open();
        Total = 0;
        Index = 0;
        SetState(PlayerState.Idle);
    }

    private async Task Run(int index, int gen)
    {
        bool Alive() => gen == _generation;
        try
        {
            await _host.Present(index);
            if (!Alive()) return;

            _narrator.Prefetch(Range(index, Total));
            var clips = _narrator.Clips(index);

            if (clips.Count == 0)
            {
                await Sleep(_narrator.SilentDurationMs(index));
                if (!Alive()) return;
            }

            foreach (var clip in clips)
            {
                string file;
                try
                {
                    file = await clip;
                }
                catch (Exception ex)
                {
                    if (!Alive() || ex is OperationCanceledException) return;
                    _host.Error(ex, index);
                    continue;
                }
                if (!Alive()) return;
                await _gate.Wait();
                if (!Alive()) return;
                await _audio.Play(file);
                if (!Alive()) return;
            }

            if (index >= Total - 1)
            {
                SetState(PlayerState.Finished);
                return;
            }

            var options = _host.Options();
            if (!options.AutoAdvance)
            {
                SetState(PlayerState.Waiting);
                return;
            }

            await Sleep(options.PauseBetweenStepsMs);
            if (!Alive()) return;
            Index = index + 1;
            _host.Changed();
            await Run(index + 1, gen);
        }
        catch (Exception ex)
        {
            if (Alive()) _host.Error(ex, index);
        }
    }

    /// <summary>Delay that also honours pause.</summary>
    private async Task Sleep(int ms)
    {
        if (ms > 0) await _delay(ms);
        await _gate.Wait();
    }

    private void SetState(PlayerState state)
    {
        State = state;
        _host.Changed();
    }

    private static List<int> Range(int from, int to)
    {
        var list = new List<int>();
        for (int i = from; i < to; i++) list.Add(i);
        return list;
    }

    private sealed class Gate
    {
        private bool _closed;
        private readonly List<TaskCompletionSource<bool>> _waiters = new();

        public void Close() => _closed = true;

        public void Open()
        {
            _closed = false;
            var waiters = _waiters.ToArray();
            _waiters.Clear();
            foreach (var w in waiters) w.TrySetResult(true);
        }

        public Task Wait()
        {
            if (!_closed) return Task.CompletedTask;
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiters.Add(tcs);
            return tcs.Task;
        }
    }
}
