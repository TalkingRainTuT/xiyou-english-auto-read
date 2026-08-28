// Xiaoyou-audio.cs — record the app's example pronunciation, replay it into the mic (NAudio version).
// Usage:
//   list
//   capture "<deviceName|index|^default>" <seconds> <out.wav>
//   play   "<deviceName|index|^default>" <in.wav>
//   loop   "<captureDev>" "<playDev>" <seconds> <out.wav>   (capture then immediately play back, for a quick self-test)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NAudio.Wave;

static class XA {
  static WaveInEvent OpenCapture(string name, WaveFormat fmt) {
    int dev = ResolveIn(name);
    var wi = new WaveInEvent { DeviceNumber = dev, WaveFormat = fmt, BufferMilliseconds = 50 };
    return wi;
  }
  static int ResolveIn(string name) {
    int n = WaveInEvent.DeviceCount;
    for (int i = 0; i < n; i++) { var s = WaveInEvent.GetCapabilities(i).ProductName; if (name.StartsWith("^") ? i == int.Parse(name.Substring(1)) : name == "^default" || name == "default" || s.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) return i; }
    int idx; if (int.TryParse(name, out idx) && idx >= 0 && idx < n) return idx;
    throw new Exception("capture device not found: " + name);
  }
  static int ResolveOut(string name) {
    int n = WaveInterop.waveOutGetNumDevs();
    for (int i = 0; i < n; i++) { var s = GetOutName(i); if (name.StartsWith("^") ? i == int.Parse(name.Substring(1)) : name == "^default" || name == "default" || s.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) return i; }
    int idx; if (int.TryParse(name, out idx) && idx >= 0 && idx < n) return idx;
    throw new Exception("playback device not found: " + name);
  }
  static string GetOutName(int i) {
    WaveOutCapabilities caps;
    WaveInterop.waveOutGetDevCaps((IntPtr)i, out caps, System.Runtime.InteropServices.Marshal.SizeOf(typeof(WaveOutCapabilities)));
    return caps.ProductName;
  }

  static void List() {
    Console.WriteLine("== capture (inputs) ==");
    for (int i = 0; i < WaveInEvent.DeviceCount; i++) Console.WriteLine($"[{i}] {WaveInEvent.GetCapabilities(i).ProductName}");
    Console.WriteLine("== playback (outputs) ==");
    int n = WaveInterop.waveOutGetNumDevs();
    for (int i = 0; i < n; i++) Console.WriteLine($"[{i}] {GetOutName(i)}");
  }

  static WaveFormat Fmt { get { return new WaveFormat(48000, 16, 1); } }

  public static void Capture(string name, int seconds, string outWav) {
    var wi = OpenCapture(name, Fmt);
    var ms = new MemoryStream();
    var writer = new WaveFileWriter(ms, wi.WaveFormat);
    bool done = false;
    wi.DataAvailable += (s, e) => { try { if (!done) writer.Write(e.Buffer, 0, e.BytesRecorded); } catch { } };
    wi.StartRecording();
    System.Threading.Thread.Sleep(seconds * 1000 + 200);
    done = true;
    try { wi.StopRecording(); } catch { }
    writer.Flush();
    var bytes = ms.ToArray();
    try { writer.Dispose(); } catch { }
    try { wi.Dispose(); } catch { }
    File.WriteAllBytes(outWav, bytes);
    Console.WriteLine($"captured {bytes.Length} bytes -> {outWav}");
  }

  public static void Play(string name, string wavFile) {
    int dev = ResolveOut(name);
    using (var reader = new AudioFileReader(wavFile)) {
      using (var wo = new WaveOutEvent { DeviceNumber = dev, DesiredLatency = 120 }) {
        wo.Init(reader);
        wo.Play();
        while (wo.PlaybackState == PlaybackState.Playing) System.Threading.Thread.Sleep(20);
      }
    }
    Console.WriteLine("played " + wavFile);
  }

  public static void Loop(string captureDev, string playDev, int seconds, string wavFile) {
    Capture(captureDev, seconds, wavFile);
    Play(playDev, wavFile);
  }

  static int Main(string[] args) {
    try {
      Console.OutputEncoding = System.Text.Encoding.UTF8;
      if (args.Length == 0 || args[0] == "list") { List(); return 0; }
      if (args[0] == "capture") { Capture(args[1], int.Parse(args[2]), args[3]); return 0; }
      if (args[0] == "play") { Play(args[1], args[2]); return 0; }
      if (args[0] == "loop") { Loop(args[1], args[2], int.Parse(args[3]), args[4]); return 0; }
      Console.WriteLine("usage: list | capture <dev> <sec> <out.wav> | play <dev> <in.wav> | loop <cap> <play> <sec> <out.wav>");
      return 2;
    } catch (Exception e) { Console.Error.WriteLine("ERR: " + e.Message); return 1; }
  }
}
