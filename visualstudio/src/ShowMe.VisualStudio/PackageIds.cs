namespace ShowMe.VisualStudio;

/// <summary>Must match the symbols in ShowMePackage.vsct.</summary>
internal static class PackageGuids
{
    public const string PackageString = "b130b44e-4a71-4b71-b2be-0423f302389d";
    public const string CmdSetString = "084e358b-6c77-42ad-8e65-15904c1f6d7f";
    public const string WalkthroughPaneString = "986432ee-f7ef-4148-9f66-eca2ac5c78ba";
}

internal static class PackageIds
{
    public const int OpenWalkthrough = 0x0100;
    public const int PlayTour = 0x0101;
    public const int TogglePause = 0x0102;
    public const int Next = 0x0103;
    public const int Previous = 0x0104;
    public const int Replay = 0x0105;
    public const int Stop = 0x0106;
    public const int ReplayTour = 0x0107;
    public const int InstallSkill = 0x0108;
    public const int TestVoice = 0x0109;
}

internal static class Vsix
{
    public const string Name = "V-ShowMe";
    public const string Description = "Narrated code walkthroughs: an AI agent opens files, highlights code and explains it out loud.";
    public const string Version = "0.1.0";
}
