using System.ComponentModel;
using System.Runtime.InteropServices;
using Community.VisualStudio.Toolkit;

namespace ShowMe.VisualStudio;

public enum TtsEngine
{
    [Description("Kokoro (natural, runs locally)")]
    Kokoro,

    [Description("Windows voice")]
    Windows,

    [Description("None (captions only)")]
    None,
}

/// <summary>The voices ShowMe ships (same list as the VS Code setting).</summary>
public enum KokoroVoice
{
    af_heart,
    af_bella,
    af_nicole,
    af_sarah,
    af_sky,
    am_michael,
    am_fenrir,
    am_puck,
    bf_emma,
    bf_isabella,
    bm_george,
    bm_fable,
}

public enum KokoroModelSize
{
    [Description("Full precision (~325 MB download)")]
    fp32,

    [Description("Small (~165 MB download)")]
    q8,
}

/// <summary>Tools › Options › ShowMe › General. Mirrors the VS Code settings.</summary>
public class General : BaseOptionModel<General>
{
    [Category("Voice")]
    [DisplayName("Engine")]
    [Description("Kokoro is a natural-sounding neural voice that runs on your machine (one-time download). Until it is ready, ShowMe uses the Windows voice.")]
    [DefaultValue(TtsEngine.Kokoro)]
    [TypeConverter(typeof(EnumConverter))]
    public TtsEngine Engine { get; set; } = TtsEngine.Kokoro;

    [Category("Voice")]
    [DisplayName("Kokoro voice")]
    [Description("af/am = American female/male, bf/bm = British female/male.")]
    [DefaultValue(KokoroVoice.af_heart)]
    public KokoroVoice KokoroVoice { get; set; } = KokoroVoice.af_heart;

    [Category("Voice")]
    [DisplayName("Kokoro model")]
    [Description("Which Kokoro model to download and run.")]
    [DefaultValue(KokoroModelSize.fp32)]
    public KokoroModelSize KokoroModel { get; set; } = KokoroModelSize.fp32;

    [Category("Voice")]
    [DisplayName("Windows voice")]
    [Description("An installed Windows voice, e.g. \"Microsoft Zira Desktop\". Empty = the system default.")]
    [DefaultValue("")]
    public string WindowsVoice { get; set; } = "";

    [Category("Voice")]
    [DisplayName("Speed")]
    [Description("Speech speed multiplier, 0.5 to 2.")]
    [DefaultValue(1.0)]
    public double Speed { get; set; } = 1.0;

    [Category("Playback")]
    [DisplayName("Auto advance")]
    [Description("Move to the next step when the narration finishes. When off, wait for Next.")]
    [DefaultValue(true)]
    public bool AutoAdvance { get; set; } = true;

    [Category("Playback")]
    [DisplayName("Pause between steps (ms)")]
    [Description("A moment to look at the code before the next step.")]
    [DefaultValue(600)]
    public int PauseBetweenSteps { get; set; } = 600;

    [Category("Playback")]
    [DisplayName("Play new tours automatically")]
    [Description("Start playing when an agent writes a new tour into .showme/tours/.")]
    [DefaultValue(true)]
    public bool AutoPlayNewTours { get; set; } = true;

    [Category("Editor")]
    [DisplayName("Dim other lines")]
    [Description("Fade out the lines that are not part of the current step.")]
    [DefaultValue(true)]
    public bool DimOtherLines { get; set; } = true;

    [Category("Editor")]
    [DisplayName("Inline captions")]
    [Description("Show the narration in a bubble directly under the highlighted code.")]
    [DefaultValue(true)]
    public bool InlineCaptions { get; set; } = true;

    public double ClampedSpeed => Speed < 0.5 ? 0.5 : Speed > 2 ? 2 : Speed;
}

internal partial class OptionsProvider
{
    [ComVisible(true)]
    public class GeneralOptions : BaseOptionPage<General> { }
}
