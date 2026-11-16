// The parts that can only be checked on the phone: AVPlayer on a visionOS
// googlevideo URL, the audio session that keeps playing with the screen locked,
// and the lock-screen / Control Center controls.

import AVFoundation
import Combine
import Foundation
import MediaPlayer
import UIKit

struct Hit: Decodable, Identifiable {
    let id: String
    let title: String
    let artist: String
    let duration: String
}

struct SearchOut: Decodable {
    var hits: [Hit] = []
    var error: String = ""
}

struct ResolvedStream: Decodable {
    var ok: Bool = false
    var title: String = ""
    var duration_ms: UInt64 = 0
    var itag: UInt64 = 0
    var url: String = ""
    var host: String = ""
    var ipbits: String = ""
    var expire: String = ""
    var hls: String = ""
    var error: String = ""
    var note: String = ""
}

enum Core {
    static func search(_ query: String) -> SearchOut {
        guard let raw = query.withCString({ ytm_search($0) }) else { return SearchOut() }
        defer { ytm_free(raw) }
        return decode(String(cString: raw)) ?? SearchOut()
    }

    static func resolve(_ videoId: String) -> ResolvedStream {
        guard let raw = videoId.withCString({ ytm_resolve($0) }) else { return ResolvedStream() }
        defer { ytm_free(raw) }
        return decode(String(cString: raw)) ?? ResolvedStream()
    }

    static func probe(_ url: String) -> String {
        guard let raw = url.withCString({ ytm_probe($0) }) else { return "null" }
        defer { ytm_free(raw) }
        return String(cString: raw)
    }

    private static func decode<T: Decodable>(_ json: String) -> T? {
        try? JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}

final class PlayerModel: ObservableObject {
    @Published var videoId = ""
    @Published var hits: [Hit] = []
    @Published var log = ""
    @Published var status = "idle"
    @Published var elapsed: Double = 0
    @Published var preferHls = false
    @Published var busy = false

    private var player: AVPlayer?
    private var last: ResolvedStream?
    private var usingHls = false
    private var nowPlayingTitle = ""
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var failedObserver: NSObjectProtocol?

    private static let visionUA =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    init() {
        configureSession()
        configureRemoteCommands()
        add("ytm iOS PoC — resolve via visionOS, play with AVPlayer")
    }

    // MARK: - Search / resolve

    func search(_ query: String) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        busy = true
        status = "searching…"
        add("search: \(q)")
        DispatchQueue.global(qos: .userInitiated).async {
            let out = Core.search(q)
            self.onMain {
                self.busy = false
                self.hits = out.hits
                if !out.error.isEmpty {
                    self.add("search failed: \(out.error)")
                }
                self.add("search: \(out.hits.count) songs")
                self.status = out.hits.isEmpty ? "no results" : "tap a song"
            }
        }
    }

    func pick(_ hit: Hit) {
        videoId = hit.id
        resolve()
    }

    func resolve() {
        let id = videoId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else {
            status = "no video id"
            return
        }
        busy = true
        status = "resolving…"
        add("resolve: \(id)")
        DispatchQueue.global(qos: .userInitiated).async {
            let r = Core.resolve(id)
            self.onMain {
                self.last = r
                self.busy = false
                self.nowPlayingTitle = r.title
                if r.ok {
                    var expiry = "?"
                    if let epoch = UInt64(r.expire) {
                        expiry = Self.clock.string(from: Date(timeIntervalSince1970: TimeInterval(epoch)))
                    }
                    self.add("resolved: itag \(r.itag) from \(r.host) ipbits=\(r.ipbits) expire=\(expiry)")
                    self.add("hls manifest: \(r.hls.isEmpty ? "none" : "yes")")
                    self.status = "resolved: \(r.title)"
                    self.probe(r.url)
                } else {
                    self.add("resolve failed: \(r.error)")
                    if !r.note.isEmpty {
                        self.add("note: \(r.note)")
                    }
                    self.status = "resolve failed"
                }
            }
        }
    }

    private func probe(_ url: String) {
        DispatchQueue.global(qos: .utility).async {
            let result = Core.probe(url)
            self.onMain { self.add("probe 1 KiB: \(result)") }
        }
    }

    // MARK: - Playback

    func play() {
        onMain { self.startItem(hls: self.preferHls) }
    }

    func resume() {
        onMain {
            self.player?.play()
            self.updateNowPlaying()
        }
    }

    func pause() {
        onMain {
            self.player?.pause()
            self.updateNowPlaying()
        }
    }

    func seek(to seconds: Double) {
        onMain {
            self.player?.seek(to: CMTime(seconds: seconds, preferredTimescale: 600))
            self.updateNowPlaying()
        }
    }

    private func startItem(hls: Bool) {
        guard let r = last else {
            status = "resolve first"
            return
        }
        let useHls = hls && !r.hls.isEmpty
        let link = useHls ? r.hls : r.url
        guard !link.isEmpty, let url = URL(string: link) else {
            add("nothing to play (ok=\(r.ok) error=\(r.error))")
            status = "nothing to play"
            return
        }
        usingHls = useHls
        teardown()

        // googlevideo checks the UA the URL was minted for; AVPlayer sends its own
        // otherwise. The key isn't public API, but it's what every player uses.
        let asset = AVURLAsset(
            url: url,
            options: ["AVURLAssetHTTPHeaderFieldsKey": [
                "User-Agent": Self.visionUA,
                "Referer": "https://www.youtube.com/",
            ]]
        )
        let item = AVPlayerItem(asset: asset)
        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        self.player = player

        add("play: \(useHls ? "HLS (itag 234)" : "progressive itag \(r.itag)") from \(url.host ?? "?")")
        status = "playing: \(r.title)"

        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            self?.onMain {
                guard let self else { return }
                switch item.status {
                case .readyToPlay:
                    let d = item.duration.seconds
                    self.add("item ready, duration \(d.isFinite ? String(format: "%.0f", d) : "?")s")
                    self.updateNowPlaying()
                case .failed:
                    self.itemFailed(item.error?.localizedDescription ?? "unknown")
                default:
                    break
                }
            }
        }
        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
        ) { [weak self] note in
            let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self?.itemFailed(error?.localizedDescription ?? "failed to play to end")
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            self?.add("finished")
            self?.status = "finished"
        }
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            guard let self else { return }
            let t = time.seconds
            if t.isFinite {
                self.elapsed = t
            }
            self.updateNowPlaying()
        }

        player.play()
        updateNowPlaying()
    }

    private func itemFailed(_ reason: String) {
        onMain {
            self.add("item failed: \(reason)")
            if !self.usingHls, let r = self.last, !r.hls.isEmpty {
                self.add("retrying over HLS…")
                self.startItem(hls: true)
            } else {
                self.status = "playback failed"
                self.add("403 means the URL is bound to another IP; a stop near 1 MiB means the network's experiment (try HLS)")
            }
        }
    }

    private func teardown() {
        if let observer = timeObserver {
            player?.removeTimeObserver(observer)
        }
        timeObserver = nil
        statusObservation?.invalidate()
        statusObservation = nil
        if let observer = endObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = failedObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        endObserver = nil
        failedObserver = nil
        player?.pause()
        player = nil
    }

    // MARK: - Session, Now Playing, remote commands

    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            add("audio session: playback, active")
        } catch {
            add("audio session failed: \(error.localizedDescription)")
        }
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let self,
                  let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .ended,
               let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
               AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) {
                self.resume()
            }
        }
    }

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            self?.resume()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.player?.timeControlStatus == .playing {
                self.pause()
            } else {
                self.resume()
            }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.seek(to: event.positionTime)
            return .success
        }
    }

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPNowPlayingInfoPropertyElapsedPlaybackTime: player?.currentTime().seconds ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: player?.rate ?? 0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPMediaItemPropertyArtist: "YouTube Music",
        ]
        if !nowPlayingTitle.isEmpty {
            info[MPMediaItemPropertyTitle] = nowPlayingTitle
        }
        if let duration = player?.currentItem?.duration.seconds, duration.isFinite, duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState =
            player?.timeControlStatus == .playing ? .playing : .paused
    }

    // MARK: - Log

    func add(_ line: String) {
        let entry = "[\(Self.clock.string(from: Date()))] \(line)"
        onMain {
            print(entry)
            self.log += entry + "\n"
            if self.log.count > 40_000 {
                self.log = String(self.log.suffix(40_000))
            }
        }
    }

    func copyLog() {
        UIPasteboard.general.string = log
    }

    private func onMain(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.async(execute: body)
        }
    }
}
