using System;
using System.Threading.Tasks;
using NAudio.Wave;
using ShowMe.Core.Playback;

namespace ShowMe.VisualStudio.Speech;

/// <summary>
/// Plays WAV clips through NAudio's WaveOutEvent (winmm), which pauses mid-word and resumes
/// where it stopped, and works on Windows N editions (no Media Player needed).
/// UI thread only.
/// </summary>
internal sealed class AudioPlayer : IAudioOut, IDisposable
{
    private sealed class Clip
    {
        public Clip(WaveOutEvent output, WaveFileReader reader)
        {
            Output = output;
            Reader = reader;
        }

        public WaveOutEvent Output { get; }
        public WaveFileReader Reader { get; }
        public TaskCompletionSource<bool> Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Started { get; set; }
    }

    private Clip? _current;
    private bool _paused;

    public Task Play(string file)
    {
        End();
        WaveFileReader? reader = null;
        try
        {
            reader = new WaveFileReader(file);
            var output = new WaveOutEvent();
            output.Init(reader);
            var clip = new Clip(output, reader);
            output.PlaybackStopped += (_, e) =>
            {
                if (e.Exception != null) Log.Line($"[audio] playback failed: {e.Exception.Message}");
                if (_current == clip) End();
            };
            _current = clip;
            if (!_paused) Start(clip);
            return clip.Done.Task;
        }
        catch (Exception ex)
        {
            reader?.Dispose();
            Log.Line($"[audio] could not play {file}: {ex.Message}");
            return Task.CompletedTask;
        }
    }

    public void Pause()
    {
        _paused = true;
        if (_current is { Started: true } c) c.Output.Pause();
    }

    public void Resume()
    {
        _paused = false;
        if (_current is { } c) Start(c);
    }

    public void Stop()
    {
        End();
        _paused = false;
    }

    public void Dispose() => Stop();

    private static void Start(Clip clip)
    {
        clip.Started = true;
        clip.Output.Play();
    }

    /// <summary>Ends the current clip, completing its Play task, without touching the paused flag.</summary>
    private void End()
    {
        var c = _current;
        if (c == null) return;
        _current = null;
        try
        {
            c.Output.Stop();
        }
        catch (Exception)
        {
            // Already stopped.
        }
        c.Output.Dispose();
        c.Reader.Dispose();
        c.Done.TrySetResult(true);
    }
}
