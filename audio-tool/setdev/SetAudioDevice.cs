// SetAudioDevice.cs — set the default playback/receording audio device on Windows via Core Audio (IPolicyConfig).
// Usage:  SetAudioDevice capture "<nameSubstring>"   |   SetAudioDevice render "<nameSubstring>"   |   list
using System;
using System.Runtime.InteropServices;

static class P {
  const int E_RENDER = 0, E_CAPTURE = 1;
  const int DEVICE_STATE_ACTIVE = 0x1, DEVICE_STATE_DISABLED = 0x2, DEVICE_STATE_NOTPRESENT = 0x4, DEVICE_STATE_UNPLUGGED = 0x8;
  const int ALL_DEVICES = DEVICE_STATE_ACTIVE | DEVICE_STATE_DISABLED | DEVICE_STATE_NOTPRESENT | DEVICE_STATE_UNPLUGGED;

  [ComImport, Guid("bcde0395-e52f-467c-8e3d-c4579291692e")] class MMDeviceEnumerator { }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    int GetDevice(string id, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr p);
    int UnregisterEndpointNotificationCallback(IntPtr p);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out int pcDevices);
    int Item(int nDevice, out IMMDevice ppDevice);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IMMPropertyStore ppInterface);
    int OpenPropertyStore(int stgmAccess, out IMMPropertyStore ppProperties);
    int GetId(out IntPtr ppstrId);
    int GetState(out int pdwState);
  }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMPropertyStore {
    int GetCount(out int c);
    int GetAt(int i, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    int Commit();
  }
  [StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] struct PROPVARIANT {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr pwszVal;
  }
  const short VT_LPWSTR = 31;

  // IPolicyConfig (vista scheme) — undocumented but widely used to set the default endpoint.
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(IntPtr pszDeviceName, IntPtr ppFormat);
    int GetDeviceFormat(IntPtr pszDeviceName, int bDefault, IntPtr ppFormat);
    int ResetDeviceFormat(IntPtr pszDeviceName);
    int SetDeviceFormat(IntPtr pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod(IntPtr pszDeviceName, int bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
    int SetProcessingPeriod(IntPtr pszDeviceName, IntPtr pmftPeriod);
    int GetShareMode(IntPtr pszDeviceName, out int pMode);
    int SetShareMode(IntPtr pszDeviceName, out int mode);
    int GetPropertyValue(IntPtr pszDeviceName, int bFxStore, ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetPropertyValue(IntPtr pszDeviceName, int bFxStore, ref PROPERTYKEY key, ref PROPVARIANT pv);
    int SetDefaultEndpoint(IntPtr pszDeviceName, int role);
    int SetEndpointVisibility(IntPtr pszDeviceName, int bVisible);
  }

  static IntPtr ToPtr(string s) { return Marshal.StringToCoTaskMemUni(s); }

  static string GetDeviceId(IMMDevice d) {
    IntPtr p; d.GetId(out p); string id = Marshal.PtrToStringUni(p); Marshal.FreeCoTaskMem(p); return id;
  }
  static string GetPropString(IMMPropertyStore ps, Guid fmtid, int pid) {
    PROPERTYKEY k; k.fmtid = fmtid; k.pid = pid; PROPVARIANT pv; pv.vt = 0;
    int hr = ps.GetValue(ref k, out pv);
    string s = pv.vt == VT_LPWSTR ? Marshal.PtrToStringUni(pv.pwszVal) : $"<vt={pv.vt},hr=0x{hr:X8}>";
    if (pv.vt == VT_LPWSTR && pv.pwszVal != IntPtr.Zero) Marshal.FreeCoTaskMem(pv.pwszVal);
    return s;
  }
  static readonly Guid PKEY_Device_FriendlyName = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");

  static void List() {
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDeviceCollection c; e.EnumAudioEndpoints(E_CAPTURE, ALL_DEVICES, out c);
    Console.WriteLine("== capture (inputs) =="); Dump(c);
    e.EnumAudioEndpoints(E_RENDER, ALL_DEVICES, out c);
    Console.WriteLine("== render (outputs) =="); Dump(c);
  }
  static void Dump(IMMDeviceCollection c) {
    int n; c.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IMMDevice d; c.Item(i, out d); IMMPropertyStore ps; d.OpenPropertyStore(0, out ps);
      string name = GetPropString(ps, PKEY_Device_FriendlyName, 14) ?? "";
      string id = GetDeviceId(d); int st; d.GetState(out st);
      Console.WriteLine($"[{i}] {name}   (state={st})   {id}");
    }
  }

  static string FName(IMMDevice d) { IMMPropertyStore ps; d.OpenPropertyStore(0, out ps); return GetPropString(ps, PKEY_Device_FriendlyName, 14) ?? ""; }

  static int ShowDefault() {
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice d;
    if (e.GetDefaultAudioEndpoint(E_CAPTURE, 0, out d) == 0) Console.WriteLine("default capture (mic)  : " + FName(d));
    if (e.GetDefaultAudioEndpoint(E_RENDER, 0, out d) == 0) Console.WriteLine("default render (output): " + FName(d));
    return 0;
  }
  static int SetDefault(string direction, string substring) {
    int flow = direction == "capture" ? E_CAPTURE : E_RENDER;
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDeviceCollection c; e.EnumAudioEndpoints(flow, ALL_DEVICES, out c);
    int n; c.GetCount(out n);
    IMMDevice found = null;
    for (int i = 0; i < n && found == null; i++) {
      IMMDevice d; c.Item(i, out d); IMMPropertyStore ps; d.OpenPropertyStore(0, out ps);
      string name = GetPropString(ps, PKEY_Device_FriendlyName, 14) ?? "";
      if (name.IndexOf(substring, StringComparison.OrdinalIgnoreCase) >= 0) found = d;
    }
    if (found == null) { Console.Error.WriteLine("no device matching: " + substring); return 1; }
    IMMPropertyStore ps2; found.OpenPropertyStore(0, out ps2);
    string picked = GetPropString(ps2, PKEY_Device_FriendlyName, 14) ?? "";
    string devId = GetDeviceId(found);

    // Official private IPolicyConfig CLSID; SetDefaultEndpoint sets the default endpoint by role.
    var p = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")));
    var cfg = (IPolicyConfig)p;
    IntPtr pid = ToPtr(devId);
    cfg.SetDefaultEndpoint(pid, 0);   // eConsole = 0
    cfg.SetDefaultEndpoint(pid, 1);   // eMultimedia
    cfg.SetDefaultEndpoint(pid, 2);   // eCommunications
    Marshal.FreeCoTaskMem(pid);
    Console.WriteLine($"set {direction} default -> {picked}");
    return 0;
  }

  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);
  const int COINIT_APARTMENTTHREADED = 0x2;

  static int Main(string[] args) {
    try {
      CoInitializeEx(IntPtr.Zero, COINIT_APARTMENTTHREADED);
      if (args.Length == 0 || args[0] == "list") { List(); return 0; }
      if (args[0] == "default") { return ShowDefault(); }
      string direction = args[0];
      string substr = args.Length > 1 ? args[1] : "CABLE";
      return SetDefault(direction, substr);
    } catch (Exception ex) { Console.Error.WriteLine("ERR: " + ex.Message); return 1; }
  }
}
