using System.Text.Json;
using ShowMe.Core.Speech;
using ShowMe.Core.Status;
using ShowMe.Core.Tours;

namespace ShowMe.Core.Tests;

/// <summary>Port of the SpeechQueue tests in test/speech.test.ts.</summary>
public class SpeechQueueTests
{
    private sealed class Rig : IDisposable
    {
        public readonly FakeTime Time = FakeTime.Use();
        public readonly List<string> Started = new();
        public readonly Dictionary<string, TaskCompletionSource<string>> Pending = new();
        public readonly SpeechQueue Queue;

        public Rig()
        {
            Queue = new SpeechQueue((key, _) =>
            {
                Started.Add(key);
                var tcs = new TaskCompletionSource<string>();
                Pending[key] = tcs;
                return tcs.Task;
            });
        }

        public void Finish(string key)
        {
            Pending[key].SetResult($"/clips/{key}.wav");
            Time.Drain();
        }

        public void Dispose() => Time.Dispose();
    }

    [Fact]
    public void RunsOneJobAtATimeInRequestOrder()
    {
        using var r = new Rig();
        var a = r.Queue.Request("a", "A");
        r.Queue.Request("b", "B");
        Assert.Equal(new[] { "a" }, r.Started);
        r.Finish("a");
        Assert.Equal("/clips/a.wav", a.Result);
        Assert.Equal(new[] { "a", "b" }, r.Started);
    }

    [Fact]
    public void DeduplicatesAndCachesResults()
    {
        using var r = new Rig();
        var p1 = r.Queue.Request("a", "A");
        var p2 = r.Queue.Request("a", "A");
        Assert.Same(p1, p2);
        r.Finish("a");
        Assert.Equal("/clips/a.wav", r.Queue.Request("a", "A").Result);
        Assert.Equal(new[] { "a" }, r.Started);
    }

    [Fact]
    public void ReordersPendingJobsAndCancelsUnneededOnes()
    {
        using var r = new Rig();
        r.Queue.Request("running", "r");
        var b = r.Queue.Request("b", "B");
        r.Queue.Request("c", "C");
        r.Queue.Request("d", "D");
        r.Queue.Prioritize(new[] { "d", "c" });
        Assert.IsType<CancelledException>(b.Exception!.InnerException);
        Assert.Equal(2, r.Queue.PendingCount);
        r.Finish("running");
        Assert.Equal(new[] { "running", "d" }, r.Started);
        r.Finish("d");
        Assert.Equal(new[] { "running", "d", "c" }, r.Started);
    }

    [Fact]
    public void PropagatesSynthesisErrorsAndKeepsGoing()
    {
        using var time = FakeTime.Use();
        int n = 0;
        var queue = new SpeechQueue((key, _) => n++ == 0 ? Task.FromException<string>(new Exception("boom")) : Task.FromResult(key));
        var a = queue.Request("a", "A");
        time.Drain();
        Assert.Equal("boom", a.Exception!.InnerException!.Message);
        var b = queue.Request("b", "B");
        time.Drain();
        Assert.Equal("b", b.Result);
    }
}

public class StatusTests
{
    [Fact]
    public void WritesTheDocumentedShape()
    {
        var json = StatusJson.Serialize(new StatusSnapshot
        {
            State = "playing",
            UpdatedAt = new DateTime(2026, 11, 24, 15, 30, 14, 120, DateTimeKind.Utc),
            TourFile = ".showme/tours/20261124-153012-login-flow.json",
            TourTitle = "How login works",
            TotalSteps = 8,
            CurrentStep = new StepStatus
            {
                Number = 3, Title = "Password check", File = "src/auth/login.ts",
                Lines = new[] { 40, 52 }, ShownLines = new[] { 42, 54 }, Narration = "Then we compare the hash.",
            },
            Issues = new[]
            {
                new TourIssue(5, IssueSeverity.Warning, "Anchor \"x\" not found in file; using lines 80-91 as given."),
                new TourIssue(null, IssueSeverity.Error, "No playable steps."),
            },
        });

        Assert.EndsWith("}\n", json);
        Assert.DoesNotContain("\r", json);
        var doc = JsonDocument.Parse(json).RootElement;
        Assert.Equal(new[] { "about", "updatedAt", "state", "tour", "currentStep", "issues" }, doc.EnumerateObject().Select(p => p.Name));
        Assert.Equal("2026-11-24T15:30:14.120Z", doc.GetProperty("updatedAt").GetString());
        Assert.Equal(8, doc.GetProperty("tour").GetProperty("totalSteps").GetInt32());
        var step = doc.GetProperty("currentStep");
        Assert.Equal(new[] { "number", "title", "file", "lines", "shownLines", "narration" }, step.EnumerateObject().Select(p => p.Name));
        Assert.Equal("[42,54]", step.GetProperty("shownLines").GetRawText().Replace(" ", "").Replace("\n", ""));
        var issues = doc.GetProperty("issues").EnumerateArray().ToList();
        Assert.Equal(5, issues[0].GetProperty("step").GetInt32());
        Assert.Equal("Anchor \"x\" not found in file; using lines 80-91 as given.", issues[0].GetProperty("message").GetString());
        Assert.False(issues[1].TryGetProperty("step", out _));
        Assert.Contains("\"step\": 5", json); // two-space indentation like JSON.stringify(…, null, 2)
    }

    [Fact]
    public void WritesNullsWhenThereIsNoTour()
    {
        var doc = JsonDocument.Parse(StatusJson.Serialize(new StatusSnapshot { State = "idle" })).RootElement;
        Assert.Equal(JsonValueKind.Null, doc.GetProperty("tour").ValueKind);
        Assert.Equal(JsonValueKind.Null, doc.GetProperty("currentStep").ValueKind);
        Assert.Empty(doc.GetProperty("issues").EnumerateArray());
    }
}

public class TourPathsTests
{
    private static readonly string Ws = Path.Combine(Path.GetTempPath(), "ws");

    [Fact]
    public void ToursInShowmeResolveAgainstTheFolderAboveIt()
    {
        var tourPath = Path.Combine(Ws, ".showme", "tours", "t.json");
        var tour = new Tour("t", new List<TourStep> { new("n") });
        Assert.Equal(Path.Combine(Ws, ".showme"), TourPaths.ShowmeDirOf(tourPath));
        Assert.Equal(Ws, TourPaths.ResolveTourRoot(tourPath, tour, null));
        Assert.Equal(Path.Combine(Ws, "src", "a.ts"), TourPaths.ResolveStepPath(Ws, "src/a.ts"));
        Assert.Equal(".showme/tours/t.json", TourPaths.Relative(Ws, tourPath));
    }

    [Fact]
    public void RootInTheTourIsRelativeToTheTourFile()
    {
        var tourPath = Path.Combine(Ws, "docs", "t.json");
        var tour = new Tour("t", new List<TourStep> { new("n") }) { Root = ".." };
        Assert.Null(TourPaths.ShowmeDirOf(tourPath));
        Assert.Equal(Ws, TourPaths.ResolveTourRoot(tourPath, tour, "/elsewhere"));
        Assert.Equal(Path.Combine(Ws, ".showme"), TourPaths.StatusDirFor(tourPath, Ws));
    }
}
