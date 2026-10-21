// mic-usage — which processes are capturing or playing audio right now,
// per CoreAudio's process objects (macOS 14+). One JSON line on stdout,
// then exit:
//
//   {"processes":[{"pid":9019,"bundleId":"company.thebrowser.browser.helper","input":true,"output":true}]}
//
// Only processes with input or output running are listed. yCal's activeMeet
// detector asks this whether the BROWSER holding a Meet tab has the mic
// open: an open Meet tab is not a meeting (a tab Arc synced from the other
// Mac, a "You left the meeting" page), but a browser capturing the mic is.
// Muting in Meet keeps the capture open, so a muted listener still counts;
// leaving the call releases it within seconds.
//
// Exit 2 when the process list can't be read (pre-14 macOS, CoreAudio
// error) so the caller falls back to the tab-only signal.

import CoreAudio
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
}

func readUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var addr = address(selector)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
  return status == noErr ? value : nil
}

func readPid(_ object: AudioObjectID) -> pid_t? {
  var addr = address(kAudioProcessPropertyPID)
  var value: pid_t = 0
  var size = UInt32(MemoryLayout<pid_t>.size)
  let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
  return status == noErr ? value : nil
}

func readBundleId(_ object: AudioObjectID) -> String {
  var addr = address(kAudioProcessPropertyBundleID)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  let status = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value)
  guard status == noErr, let cf = value?.takeRetainedValue() else { return "" }
  return cf as String
}

guard #available(macOS 14.0, *) else {
  FileHandle.standardError.write("mic-usage: needs macOS 14+\n".data(using: .utf8)!)
  exit(2)
}

let system = AudioObjectID(kAudioObjectSystemObject)
var listAddr = address(kAudioHardwarePropertyProcessObjectList)
var listSize: UInt32 = 0
guard AudioObjectGetPropertyDataSize(system, &listAddr, 0, nil, &listSize) == noErr else {
  FileHandle.standardError.write("mic-usage: process list size unavailable\n".data(using: .utf8)!)
  exit(2)
}
var ids = [AudioObjectID](repeating: 0, count: Int(listSize) / MemoryLayout<AudioObjectID>.size)
guard AudioObjectGetPropertyData(system, &listAddr, 0, nil, &listSize, &ids) == noErr else {
  FileHandle.standardError.write("mic-usage: process list unavailable\n".data(using: .utf8)!)
  exit(2)
}

var rows: [[String: Any]] = []
for id in ids {
  let input = (readUInt32(id, kAudioProcessPropertyIsRunningInput) ?? 0) != 0
  let output = (readUInt32(id, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
  if !input && !output { continue }
  rows.append([
    "pid": Int(readPid(id) ?? -1),
    "bundleId": readBundleId(id),
    "input": input,
    "output": output,
  ])
}

let data = try JSONSerialization.data(withJSONObject: ["processes": rows], options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
