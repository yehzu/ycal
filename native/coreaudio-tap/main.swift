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
// Lifecycle: runs until SIGTERM/SIGINT (record-meet.sh stop), until the
// stdout pipe breaks (ffmpeg exited), until stdin hits EOF (the owning
// script is gone), until the writer stays wedged past TAP_WEDGE_S, or until
// TAP_MAX_S wall-clock. It NEVER exits on an SCStream error — it self-heals
// by restarting the stream while the writer keeps the output flowing as
// silence.
//
// EVERY terminal path must run through terminate(), which stops the SCStream
// before exiting. This is load-bearing: an SCStream that is never stopped
// stays registered with WindowServer for the lifetime of the process, and a
// process that never exits therefore pins a capture client — and the purple
// screen-recording indicator — forever. The 2026-08-17 leak was exactly
// this: the broken-pipe path set `running = false` and broke out of the
// writer loop, both worker threads returned, and RunLoop.main.run() then
// idled at 0% CPU holding a live stream. One escaped tap survived 10 days
// and drove WindowServer to ~28% sustained with nothing on screen.
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

private func envDouble(_ key: String, _ fallback: Double) -> Double {
    guard let raw = ProcessInfo.processInfo.environment[key],
          let v = Double(raw), v > 0 else { return fallback }
    return v
}

// Hard wall-clock ceiling. record-meet.sh passes the meeting's own budget
// (the same one it gives ffmpeg's -t); the 6h default only matters when the
// tap is launched without one. A tap has no business outliving this no
// matter what wedged upstream.
let TAP_MAX_S = envDouble("YCAL_TAP_MAX_SECONDS", 6 * 3600)

// How long the writer may stay parked inside out.write before we call the
// downstream dead. monitorLoop already *detects* this at 5s and logs the
// diagnosis; past this threshold the recording is unrecoverable anyway (the
// FIFO is full, so every sample since the stall is already lost) and the
// only thing still at stake is whether we leak the SCStream.
let TAP_WEDGE_S = envDouble("YCAL_TAP_WEDGE_SECONDS", 120)

// Watch stdin for EOF as the "my owner is gone" signal. record-meet.sh backs
// our stdin with a FIFO whose write end it pins open with a `sleep` it owns,
// specifically so this watcher has something to wait on — see its comment at
// the `stdin_fifo` setup. The pre-rewrite vendored binary honoured that
// contract; this rewrite dropped the watcher while the shell kept
// provisioning for it. Set 0 to run the tap by hand off a terminal stdin.
let TAP_STDIN_WATCH = ProcessInfo.processInfo.environment["YCAL_TAP_STDIN_WATCH"] != "0"

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

    // terminate() guard — several independent threads can reach a terminal
    // condition at once (writer sees the broken pipe while monitorLoop trips
    // the wedge timer while SIGTERM lands).
    private let exitLock = NSLock()
    private var exiting = false

    // Health/contract state (shared across sample/control queues + writer thread).
    // record-meet.sh's watch_tap_health() greps for `restart 10/10` + `dead audio`
    // to decide the tap is permanently gone and fail the recording loudly, instead
    // of silently shipping a dead system-audio channel (the SDET-Monthly bug).
    private let stateLock = NSLock()
    private let maxRestarts = 10
    private var restartCount = 0                 // CONSECUTIVE failed restarts; reset when audio flows
    private var lastAudioAt = Date()             // last time real system samples arrived
    private var lastDeadLog = Date(timeIntervalSince1970: 0)
    private var declaredDead = false             // writer has already logged the 10/10 give-up line

    // ── Instrumentation (read by the independent monitorLoop) ─────────────
    // Added 2026-06-02 after a 100-min meeting froze at 45 min with ZERO log
    // output — the writer was blocked inside out.write (ffmpeg stopped
    // draining the FIFO) and the old logging only fired on SCStream errors,
    // which never came. These let monitorLoop name the failure next time.
    private var writeInFlight = false            // true while parked in out.write
    private var lastWriteStartAt = Date()
    private var maxWriteMs: Double = 0           // slowest write this heartbeat window
    private var realSamplesWindow = 0            // real system samples this window
    private var silencePadWindow = 0            // silence samples padded this window
    private var blockedWarned = false            // throttle the "writer blocked" line

    func begin() {
        Thread.detachNewThread { [weak self] in self?.writerLoop() }
        Thread.detachNewThread { [weak self] in self?.monitorLoop() }
        if TAP_STDIN_WATCH { Thread.detachNewThread { [weak self] in self?.stdinWatcher() } }
        Task { await self.startCapture() }
    }

    func stop() {
        running = false
        stream?.stopCapture { _ in }
        stream = nil
    }

    // The ONLY way this process exits. Callable from any thread, idempotent,
    // and it always releases the SCStream first — see the leak note in the
    // file header for why that ordering is the whole point.
    //
    // _exit rather than exit: the wedged-writer path calls this while another
    // thread is parked in a write(2) that will never return, and we don't
    // want an atexit handler to deadlock behind it. Nothing here is buffered
    // (FileHandle.write is a bare syscall), so there is no flush to lose.
    func terminate(_ reason: String, code: Int32 = 0) -> Never {
        exitLock.lock()
        if exiting {
            exitLock.unlock()
            // Another thread is already tearing down; park rather than race
            // it to _exit, and let its call end the process.
            while true { Thread.sleep(forTimeInterval: 1) }
        }
        exiting = true
        exitLock.unlock()

        elog("exiting: \(reason)")
        running = false
        if let s = stream {
            stream = nil
            // stopCapture is async and can itself wedge (same class of hang
            // withTimeout() exists for), so bound the wait. Two seconds is
            // plenty for ScreenCaptureKit to deregister; past that we accept
            // that quitting the process is the stronger cleanup anyway.
            let done = DispatchSemaphore(value: 0)
            s.stopCapture { _ in done.signal() }
            if done.wait(timeout: .now() + 2) == .timedOut {
                elog("stopCapture did not return within 2s — exiting anyway")
            }
        }
        _exit(code)
    }

    // MARK: – orphan watch

    private func stdinWatcher() {
        var buf = [UInt8](repeating: 0, count: 256)
        while true {
            let n = read(0, &buf, buf.count)
            if n == 0 { terminate("stdin EOF — the recording's owner is gone") }
            if n < 0 {
                if errno == EINTR { continue }
                // Don't treat a read error as an orphan signal — that would
                // turn a stdin quirk into a killed recording. Just stand down
                // and leave the other exit paths in charge.
                elog("stdin watcher read error (errno \(errno)) — orphan watch off")
                return
            }
        }
    }

    // MARK: – capture setup + restart

    // Race an async op against a timeout. SCShareableContent.current and
    // startCapture() can WEDGE (e.g. after `application connection interrupted`
    // when the display has slept) and never return — which is exactly how the
    // SDET recording hung: the control path stalled while the writer emitted
    // 29min of silence. A timeout turns the wedge into a throw so we keep
    // retrying (and recover once the display wakes) instead of hanging forever.
    private func withTimeout<T>(_ seconds: Double,
                                _ operation: @escaping () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw NSError(domain: "ycal.tap", code: -2,
                              userInfo: [NSLocalizedDescriptionKey: "timed out after \(Int(seconds))s"])
            }
            defer { group.cancelAll() }
            guard let result = try await group.next() else { throw CancellationError() }
            return result
        }
    }

    func startCapture() async {
        do {
            let content = try await withTimeout(8) { try await SCShareableContent.current }
            guard let display = content.displays.first else {
                elog("no display available"); scheduleRestart(); return
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
            try await withTimeout(8) { try await s.startCapture() }
            self.stream = s
            elog("capture started")
        } catch {
            elog("startCapture failed: \(error.localizedDescription)")
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

            self.stateLock.lock()
            self.restartCount += 1
            let n = self.restartCount
            self.stateLock.unlock()

            // Fast first recovery (the screen-share case this rewrite exists for),
            // then back off if the fault is persistent (e.g. Screen-Recording
            // permission missing for the helper, or replayd's XPC connection being
            // repeatedly interrupted — the SDET case, where the stream "starts" but
            // never delivers a sample). `restart N/10` is the contract string
            // watch_tap_health() greps; we pin the display at 10/10 so it keeps
            // matching while we keep retrying (a late recovery still resets us).
            let shown = min(n, self.maxRestarts)
            let backoff: Double = n <= 1 ? 1.0 : (n == 2 ? 2.0 : 4.0)
            elog("restart \(shown)/\(self.maxRestarts) (retry in \(Int(backoff))s)")
            self.controlQueue.asyncAfter(deadline: .now() + backoff) {
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

            // Real audio is flowing → reset the consecutive-failure counter, so a
            // transient screen-share eviction (which recovers on the next restart)
            // never marches the counter to 10/10. Only a persistent fault that never
            // delivers a sample keeps climbing.
            stateLock.lock()
            lastAudioAt = Date()
            let wasFailing = restartCount
            restartCount = 0
            declaredDead = false
            stateLock.unlock()
            if wasFailing != 0 { elog("audio flowing — restart counter reset") }
        }
    }

    // MARK: – steady writer (wall-clock paced, silence-filled)

    private func writerLoop() {
        let tick = 0.05   // 50ms
        while running {
            Thread.sleep(forTimeInterval: tick)

            // Permanently-broken-capture signal. If we've had at least one failed
            // restart (restartCount>0) AND no real samples for >3s, log `dead audio`
            // (throttled). A merely quiet room leaves restartCount at 0, so this
            // stays silent — it only fires when capture is actually down. The bash
            // watcher counts these after `restart 10/10` to fail the recording.
            let now = Date()
            stateLock.lock()
            let silentFor = now.timeIntervalSince(lastAudioAt)
            let restarts = restartCount
            var emitDead = false
            var emitGiveup = false
            if restarts > 0 && silentFor > 3.0 && now.timeIntervalSince(lastDeadLog) > 3.0 {
                lastDeadLog = now; emitDead = true
            }
            // Backstop: capture has produced nothing for 20s+ since a failure —
            // including the case where startCapture() itself wedged so the restart
            // counter stopped climbing toward 10/10 on its own. Declare exhaustion
            // here so watch_tap_health() sees `restart 10/10` and fails the recording
            // loudly. This thread is independent of the (possibly stuck) control path.
            if restarts > 0 && silentFor > 20.0 && !declaredDead {
                declaredDead = true; emitGiveup = true
            }
            stateLock.unlock()
            if emitGiveup { elog("restart \(maxRestarts)/\(maxRestarts) (no system audio for \(Int(silentFor))s — giving up)") }
            if emitDead { elog("dead audio — no system samples for \(Int(silentFor))s") }

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

            stateLock.lock(); writeInFlight = true; lastWriteStartAt = Date(); stateLock.unlock()
            let wstart = Date()
            let ok = chunk.withUnsafeBytes { raw -> Bool in
                do { try out.write(contentsOf: Data(raw)); return true }
                catch { return false }       // broken pipe → ffmpeg gone
            }
            let wms = Date().timeIntervalSince(wstart) * 1000
            stateLock.lock()
            writeInFlight = false
            if wms > maxWriteMs { maxWriteMs = wms }
            realSamplesWindow += take
            silencePadWindow += (need - take)
            stateLock.unlock()
            // Broken pipe → ffmpeg is gone → the recording is over. This MUST
            // exit, not merely stop the loop: leaving RunLoop.main.run() to
            // idle here is what stranded a live SCStream for 10 days.
            if !ok { terminate("stdout closed — ffmpeg exited") }
            emitted += need

            if Date().timeIntervalSince(startDate) > TAP_MAX_S {
                terminate("hit the \(Int(TAP_MAX_S))s wall-clock ceiling")
            }
        }
    }

    // Independent watchdog + heartbeat. Runs on its OWN thread so that even
    // when the writer is wedged blocking on out.write (ffmpeg stopped draining
    // the FIFO because its `join` filtergraph deadlocked), we STILL emit a
    // diagnostic every 15s. This turns "the recording froze and nobody knows
    // why" into a labelled root cause in the tap log.
    private func monitorLoop() {
        let period = 15.0
        while running {
            Thread.sleep(forTimeInterval: period)
            let now = Date()
            stateLock.lock()
            let inFlight = writeInFlight
            let writeAge = now.timeIntervalSince(lastWriteStartAt)
            let sinceAudio = now.timeIntervalSince(lastAudioAt)
            let real = realSamplesWindow
            let sil = silencePadWindow
            let mw = maxWriteMs
            let rc = restartCount
            let alreadyWarned = blockedWarned
            realSamplesWindow = 0; silencePadWindow = 0; maxWriteMs = 0
            stateLock.unlock()
            ringLock.lock(); let rd = ring.count; ringLock.unlock()

            elog("stats: real=\(real) silencePad=\(sil) ring=\(rd) sinceRealAudio=\(Int(sinceAudio))s maxWriteMs=\(Int(mw)) restartCount=\(rc) emitted=\(emitted)")

            // Downstream wedge: the writer is parked inside out.write, so ffmpeg
            // isn't draining the FIFO — its filtergraph deadlocked (the `join`
            // hard-sync starves whenever EITHER input, mic OR sys, stops). This
            // is the 2026-06-02 ACE-meeting freeze signature.
            if inFlight && writeAge > 5 && !alreadyWarned {
                elog("WARNING writer BLOCKED on stdout write for \(Int(writeAge))s — ffmpeg not draining FIFO (downstream join wedged? suspect the mic/avfoundation input #1)")
                stateLock.lock(); blockedWarned = true; stateLock.unlock()
            } else if !inFlight && alreadyWarned {
                elog("writer unblocked after stall — FIFO draining again")
                stateLock.lock(); blockedWarned = false; stateLock.unlock()
            }

            // The writer cannot rescue itself here — it is parked in a write(2)
            // that only returns if ffmpeg drains or dies, and a wedged ffmpeg
            // does neither. This thread is the only one left that can act, so
            // past TAP_WEDGE_S it ends the process rather than let the tap sit
            // on a live SCStream indefinitely. Everything since the stall is
            // already lost to the full FIFO; there is nothing to preserve by
            // waiting longer.
            if inFlight && writeAge > TAP_WEDGE_S {
                terminate("writer wedged in stdout write for \(Int(writeAge))s — downstream is not coming back")
            }

            // Same ceiling the writer checks, enforced from a thread that keeps
            // running even when the writer is blocked.
            if now.timeIntervalSince(startDate) > TAP_MAX_S {
                terminate("hit the \(Int(TAP_MAX_S))s wall-clock ceiling")
            }

            // Silent SCK stall: real system samples stopped but SCStream never
            // fired didStopWithError, so restartCount stayed 0 and the existing
            // restart path never engaged. (A merely quiet room still arrives as
            // real sample buffers, so >5s with zero real samples is a true stall.)
            if sinceAudio > 5 && rc == 0 {
                elog("WARNING no real system samples for \(Int(sinceAudio))s with no SCStream error (silent ScreenCaptureKit stall?)")
            }
        }
    }
}

// A broken stdout (ffmpeg exited) should surface as a throwing write, not
// kill us with SIGPIPE.
signal(SIGPIPE, SIG_IGN)

let tap = SystemAudioTap()

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
// These only fire while the main queue is being serviced, which is why they
// are a convenience rather than the safety net: SIGTERM is SIG_IGN'd above,
// so a wedged main queue swallows it outright and record-meet.sh's escalation
// to SIGKILL is what actually lands. The self-termination paths inside the
// tap (stdin EOF, broken pipe, wedge timer, wall clock) are what make the
// process bounded without anyone having to signal it at all.
let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigTerm.setEventHandler { tap.terminate("SIGTERM") }
sigTerm.resume()
let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigInt.setEventHandler { tap.terminate("SIGINT") }
sigInt.resume()

elog("starting (ScreenCaptureKit, resilient; out=\(Int(OUT_SR))Hz/1ch f32le, "
     + "maxS=\(Int(TAP_MAX_S)) wedgeS=\(Int(TAP_WEDGE_S)) stdinWatch=\(TAP_STDIN_WATCH))")
tap.begin()
RunLoop.main.run()
