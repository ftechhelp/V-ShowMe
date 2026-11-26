using System;
using System.IO;
using System.Speech.Synthesis;
using System.Threading.Tasks;

namespace ShowMe.VisualStudio.Speech;

/// <summary>The built-in Windows (SAPI) voices: instant, no download. The fallback while Kokoro downloads.</summary>
internal static class WindowsVoice
{
    public static Task SpeakToFileAsync(string text, string outFile, string voice, double speed) =>
        Task.Run(() =>
        {
            var tmp = $"{outFile}.{Environment.TickCount}.tmp.wav";
            using (var synth = new SpeechSynthesizer())
            {
                if (!string.IsNullOrWhiteSpace(voice))
                {
                    try
                    {
                        synth.SelectVoice(voice);
                    }
                    catch (ArgumentException)
                    {
                        Log.Line($"[tts] Windows voice \"{voice}\" not found; using the default");
                    }
                }
                synth.Rate = SapiRate(speed);
                synth.SetOutputToWaveFile(tmp);
                synth.Speak(text);
                synth.SetOutputToNull();
            }
            if (File.Exists(outFile)) File.Delete(outFile);
            File.Move(tmp, outFile);
        });

    /// <summary>SAPI rate is -10..10, where ±10 is about 3× faster or slower (same mapping as VS Code).</summary>
    public static int SapiRate(double speed)
    {
        int rate = (int)Math.Floor(10 * Math.Log(speed) / Math.Log(3) + 0.5);
        return Math.Max(-10, Math.Min(10, rate));
    }
}
