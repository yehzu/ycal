// coreaudio-tap — resilient system-audio capture via ScreenCaptureKit,
// streamed as raw float32 mono PCM @16kHz to stdout for ffmpeg.
//
// First-party rewrite (replacing the vendored CJHwong/lazy-take-notes
// binary). Its whole reason to exist is RESILIENCE: when macOS stops the
// SCStream "by the system" — which happens the moment a meeting participant
// starts screen-sharing — we recreate the stream and keep going. And we
// emit a STEADY 16kHz stream the entire time (silence during the brief
// outage) so the recording timeline never freezes and never desyncs from
// the microphone channel ffmpeg joins it with. The result is ONE continuous
// recording across screen-shares, instead of a file that dead-ends at the
// first share (the bug this replaces).
//
// Output contract (UNCHANGED, so record-meet.sh needs no edits):
//   raw f32le, mono, 16000 Hz  → consumed as `-f f32le -ar 16000 -ac 1`.
//
// Lifecycle: runs until SIGTERM/SIGINT (record-meet.sh stop) or until the
// stdout pipe breaks (ffmpeg exited). It NEVER exits on an SCStream error —
// it self-heals by restarting the stream while the writer keeps the output
// flowing as silence.
//
// Requires Screen Recording permission (inherited from the spawning yCal
// app's TCC grant, same as the binary it replaces). macOS 13+.

import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreMedia

let OUT_SR: Double = 16000

func elog(_ s: String) {
    FileHandle.standardError.write(Data(("coreaudio-tap: " + s + "\n").utf8))
}

final class SystemAudioTap: NSObject, SCStreamDelegate, SCStreamOutput {
    private let sampleQueue = DispatchQueue(label: "coreaudio-tap.sample")
    private let controlQueue = DispatchQueue(label: "coreaudio-tap.control")
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var converterKey = ""
    private let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: OUT_SR, channels: 1, interleaved: false)!

    // Ring of converted 16kHz mono samples awaiting the steady writer.
    private let ringLock = NSLock()
    private var ring = [Float]()
    private let maxRing = Int(OUT_SR) * 5      // 5s cap; drop oldest if writer ever falls behind

    private var restartScheduled = false
    private let startDate = Date()
    private var emitted = 0                     // total 16kHz samples written to stdout
    private var running = true
    private let out = FileHandle.standardOutput

    func begin() {
        Thread.detachNewThread { [weak self] in self?.writerLoop() }
        Task { await self.startCapture() }
    }

    func stop() {
        running = false
        stream?.stopCapture { _ in }
        stream = nil
    }

    // MARK: – capture setup + restart

    func startCapture() async {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                elog("no display available — retrying"); scheduleRestart(); return
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.capturesAudio = true
            cfg.excludesCurrentProcessAudio = true      // don't record yCal's own output
            cfg.sampleRate = 48000
            cfg.channelCount = 2
            // We only want audio; capture a 2×2 / 1fps video we ignore so
            // the stream is cheap. (No audio-only SCStream mode pre-15.)
            cfg.width = 2
            cfg.height = 2
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            cfg.queueDepth = 5

            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
            try await s.startCapture()
            self.stream = s
            elog("capture started")
        } catch {
            elog("startCapture failed: \(error.localizedDescription) — retrying in 1s")
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        controlQueue.async { [weak self] in
            guard let self, self.running, !self.restartScheduled else { return }
            self.restartScheduled = true
            // Tear the old stream down before recreating so we don't leak
            // SCStream instances across repeated system stops.
            self.stream?.stopCapture { _ in }
            self.stream = nil
            self.controlQueue.asyncAfter(deadline: .now() + 1.0) {
                self.restartScheduled = false
                Task { await self.startCapture() }
            }
        }
    }

    // MARK: – SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // THE case this rewrite exists for: macOS evicted our stream
        // (typically when someone starts screen-sharing). Don't die — the
        // writer keeps emitting silence; we recreate the stream and resume.
        elog("stream stopped by the system: \(error.localizedDescription) — restarting")
        scheduleRestart()
    }

    // MARK: – SCStreamOutput (audio samples → ring)

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, running, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else { return }
        var asbd = asbdPtr.pointee
        guard let inFormat = AVAudioFormat(streamDescription: &asbd) else { return }

        let key = "\(asbd.mSampleRate)/\(asbd.mChannelsPerFrame)/\(asbd.mFormatFlags)"
        if converter == nil || converterKey != key {
            converter = AVAudioConverter(from: inFormat, to: outFormat)
            converterKey = key
        }
        guard let converter else { return }

        _ = try? sampleBuffer.withAudioBufferList { abl, _ in
            guard let inBuf = AVAudioPCMBuffer(
                pcmFormat: inFormat, bufferListNoCopy: abl.unsafePointer, deallocator: nil)
            else { return }
            let cap = AVAudioFrameCount(Double(inBuf.frameLength) * OUT_SR / inFormat.sampleRate) + 1024
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return }
            var fed = false
            var err: NSError?
            converter.convert(to: outBuf, error: &err) { _, status in
                if fed { status.pointee = .noDataNow; return nil }
                fed = true; status.pointee = .haveData; return inBuf
            }
            if err != nil { return }
            let n = Int(outBuf.frameLength)
            guard n > 0, let ch = outBuf.floatChannelData else { return }
            let samples = UnsafeBufferPointer(start: ch[0], count: n)
            ringLock.lock()
            ring.append(contentsOf: samples)
            if ring.count > maxRing { ring.removeFirst(ring.count - maxRing) }
            ringLock.unlock()
        }
    }

    // MARK: – steady writer (wall-clock paced, silence-filled)

    private func writerLoop() {
        let tick = 0.05   // 50ms
        while running {
            Thread.sleep(forTimeInterval: tick)
            // How many samples SHOULD exist by now, in real time. Emitting
            // to this target — pulling real audio where we have it, padding
            // with silence where we don't — keeps the stream continuous and
            // wall-clock accurate so the mic channel stays in sync.
            let target = Int(Date().timeIntervalSince(startDate) * OUT_SR)
            var need = target - emitted
            if need <= 0 { continue }
            if need > Int(OUT_SR) { need = Int(OUT_SR) }   // clamp post-suspend catch-up to 1s

            var chunk = [Float](repeating: 0, count: need)   // silence by default
            ringLock.lock()
            let take = min(need, ring.count)
            if take > 0 {
                for i in 0..<take { chunk[i] = ring[i] }
                ring.removeFirst(take)
            }
            ringLock.unlock()

            let ok = chunk.withUnsafeBytes { raw -> Bool in
                do { try out.write(contentsOf: Data(raw)); return true }
                catch { return false }       // broken pipe → ffmpeg gone
            }
            if !ok { running = false; break }
            emitted += need
        }
    }
}

// A broken stdout (ffmpeg exited) should surface as a throwing write, not
// kill us with SIGPIPE.
signal(SIGPIPE, SIG_IGN)

let tap = SystemAudioTap()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigTerm.setEventHandler { tap.stop(); exit(0) }
sigTerm.resume()
let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigInt.setEventHandler { tap.stop(); exit(0) }
sigInt.resume()

elog("starting (ScreenCaptureKit, resilient; out=\(Int(OUT_SR))Hz/1ch f32le)")
tap.begin()
RunLoop.main.run()
