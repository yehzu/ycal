// voiceproc-mic — capture the microphone through Apple's Voice-Processing
// I/O (the same AEC + noise-suppression + AGC stack FaceTime / Google Meet
// use) and stream the cleaned audio as raw float32 PCM to stdout.
//
// yCal pipes this into ffmpeg as the LEFT channel (you), alongside the
// ScreenCaptureKit system-audio tap on the RIGHT channel (everyone else) —
// see tools/recording/record-meet.sh. The whole point: when you run an
// open mic (e.g. a Yeti) next to speakers with no headphones, the raw
// avfoundation capture picks up the meeting bleeding out of the speakers,
// which pollutes the "you" channel and confuses the transcript. Voice
// Processing references the system output and subtracts that bleed, so the
// mic channel carries (closer to) just your voice — no headphones needed.
//
// Output format: float32 little-endian, MONO, 48000 Hz. Declared on the
// ffmpeg side as `-f f32le -ar 48000 -ac 1`.
//
// Lifecycle:
//   * Runs until SIGTERM / SIGINT (record-meet.sh stop) or a broken pipe
//     (ffmpeg exited) — then stops the engine and exits 0.
//   * Exits non-zero on setup failure so record-meet.sh can surface it
//     instead of producing a silent recording.
//
// Env:
//   YCAL_MIC_NAME   optional substring; pins the input device by name.
//                   Default = system default input, which is what VPIO's
//                   echo-reference logic prefers.

import Foundation
import AVFoundation
import CoreAudio

let TARGET_SR = 48000.0

func elog(_ s: String) {
    FileHandle.standardError.write(Data(("voiceproc-mic: " + s + "\n").utf8))
}

// Resolve an input AudioDeviceID by case-insensitive name substring. Only
// devices that actually expose input channels are considered, so an output
// device sharing a name (the Yeti registers both) can't be picked.
func inputDeviceID(matching needle: String) -> AudioDeviceID? {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(0)
    let sys = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr else { return nil }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    if count == 0 { return nil }
    var devices = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &devices) == noErr else { return nil }

    let want = needle.lowercased()
    for dev in devices {
        // Input channel count via stream configuration on the input scope.
        var sAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain)
        var sSize = UInt32(0)
        guard AudioObjectGetPropertyDataSize(dev, &sAddr, 0, nil, &sSize) == noErr, sSize > 0 else { continue }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(sSize), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(dev, &sAddr, 0, nil, &sSize, raw) == noErr else { continue }
        let abl = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        var channels = 0
        for b in abl { channels += Int(b.mNumberChannels) }
        if channels == 0 { continue }

        // Device name.
        var nAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var cfName: Unmanaged<CFString>?
        var nSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(dev, &nAddr, 0, nil, &nSize, &cfName) == noErr,
              let name = cfName?.takeRetainedValue() as String? else { continue }
        if name.lowercased().contains(want) { return dev }
    }
    return nil
}

// A broken pipe (ffmpeg gone) should surface as a throwing write, not kill
// the process outright — we want a clean exit 0 in that case.
signal(SIGPIPE, SIG_IGN)

let env = ProcessInfo.processInfo.environment
let engine = AVAudioEngine()
let input = engine.inputNode

// Turn on Apple Voice Processing (AEC / NS / AGC). Must happen before we
// read formats or start the engine; the node swaps to a VPIO unit here.
do {
    try input.setVoiceProcessingEnabled(true)
} catch {
    elog("setVoiceProcessingEnabled failed: \(error)")
    exit(3)
}

// Optional explicit device pin. Default (no env) leaves VPIO on the system
// default input, which is the configuration its echo-reference logic is
// happiest with.
if let name = env["YCAL_MIC_NAME"], !name.isEmpty {
    if let dev = inputDeviceID(matching: name), let au = input.audioUnit {
        var d = dev
        let st = AudioUnitSetProperty(
            au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
            0, &d, UInt32(MemoryLayout<AudioDeviceID>.size))
        if st != noErr { elog("pin device '\(name)' failed: OSStatus \(st)") }
        else { elog("pinned input device '\(name)' (id \(dev))") }
    } else {
        elog("device '\(name)' not found — using system default input")
    }
}

let inFmt = input.outputFormat(forBus: 0)   // format AFTER voice processing
guard inFmt.sampleRate > 0, inFmt.channelCount > 0 else {
    elog("input format has no sample rate / channels — is a mic connected and permitted?")
    exit(3)
}
let outFmt = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: TARGET_SR, channels: 1, interleaved: false)!
guard let converter = AVAudioConverter(from: inFmt, to: outFmt) else {
    elog("cannot build converter \(inFmt) → \(outFmt)")
    exit(3)
}

let out = FileHandle.standardOutput

input.installTap(onBus: 0, bufferSize: 4096, format: inFmt) { buf, _ in
    let ratio = TARGET_SR / inFmt.sampleRate
    let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 2048
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
    var consumed = false
    var convErr: NSError?
    let status = converter.convert(to: outBuf, error: &convErr) { _, outStatus in
        if consumed { outStatus.pointee = .noDataNow; return nil }
        consumed = true
        outStatus.pointee = .haveData
        return buf
    }
    if status == .error {
        elog("convert error \(String(describing: convErr))")
        return
    }
    let frames = Int(outBuf.frameLength)
    if frames == 0 { return }
    guard let ch = outBuf.floatChannelData else { return }
    let bytes = Data(bytes: ch[0], count: frames * MemoryLayout<Float>.size)
    do {
        try out.write(contentsOf: bytes)
    } catch {
        // ffmpeg closed the read end — recording stopped. Clean exit.
        exit(0)
    }
}

// Clean shutdown via dispatch sources so we can safely touch the engine
// (signal handlers run on a normal queue, not in async-signal context).
func shutdown() -> Never {
    input.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    exit(0)
}
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigTerm.setEventHandler { _ = shutdown() }
sigTerm.resume()
let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigInt.setEventHandler { _ = shutdown() }
sigInt.resume()

do {
    try engine.start()
} catch {
    elog("engine.start failed: \(error)")
    exit(3)
}
elog("running in=\(Int(inFmt.sampleRate))Hz/\(inFmt.channelCount)ch → out=\(Int(TARGET_SR))Hz/1ch f32le, VPIO=on")

RunLoop.main.run()
