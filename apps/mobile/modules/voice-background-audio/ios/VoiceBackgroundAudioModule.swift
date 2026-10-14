import AVFoundation
import AudioToolbox
import ExpoModulesCore
import MediaPlayer
import UserNotifications

public class VoiceBackgroundAudioModule: Module {
  private var stopRequest: URLRequest?
  private var generation: Int = 0
  private var active = false
  private var started = false
  private var resumeURL: String?
  private var waitingFor: String?
  private var stopCommand: Any?
  private var playCommand: Any?
  private var silenceWorkItem: DispatchWorkItem?
  private var silenceGeneration: Int = 0

  public func definition() -> ModuleDefinition {
    Name("VoiceBackgroundAudio")
    Events("stopRequested", "resumeRequested", "idleRequested")

    AsyncFunction("start") { (resumeURL: String?) in
      self.generation &+= 1
      self.cancelSilence()
      self.resumeURL = resumeURL ?? self.resumeURL
      self.started = true
      self.waitingFor = nil
      try self.activateAudio()
      self.active = true
      self.updateNowPlaying()
      self.refreshRemoteCommands()
      return self.generation
    }.runOnQueue(.main)

    AsyncFunction("configureStop") { (url: String, token: String, expectedGeneration: Int) in
      guard self.started, self.generation == expectedGeneration, let endpoint = URL(string: url) else { return }
      var request = URLRequest(url: endpoint, timeoutInterval: 10)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: ["token": token])
      self.stopRequest = request
    }.runOnQueue(.main)

    AsyncFunction("setActivity") { (active: Bool, waitingFor: String?, expectedGeneration: Int) in
      guard self.started, self.generation == expectedGeneration else { return }
      self.active = active
      self.waitingFor = waitingFor
      // An activity change (park/resume) invalidates any listening deadline;
      // the JS policy re-arms one if it still wants it.
      self.cancelSilence()
      if active {
        try self.activateAudio()
      } else {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      }
      self.updateNowPlaying()
      self.refreshRemoteCommands()
    }.runOnQueue(.main)

    AsyncFunction("armSilence") { (expectedGeneration: Int) in
      guard self.started, self.generation == expectedGeneration else { return }
      self.silenceWorkItem?.cancel()
      self.silenceGeneration = expectedGeneration
      let item = DispatchWorkItem { [weak self] in
        guard let self, self.started, self.generation == expectedGeneration,
              self.silenceGeneration == expectedGeneration else { return }
        self.silenceWorkItem = nil
        self.silenceGeneration = 0
        self.sendEvent("idleRequested", ["generation": expectedGeneration])
      }
      self.silenceWorkItem = item
      // One-shot, main queue: fires while the app is backgrounded as long as the
      // background audio session keeps the process alive.
      DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: item)
    }.runOnQueue(.main)

    AsyncFunction("cancelSilence") { (expectedGeneration: Int) in
      guard self.silenceGeneration == expectedGeneration else { return }
      self.cancelSilence()
    }.runOnQueue(.main)

    AsyncFunction("endForIdle") { (resumeURL: String?, expectedGeneration: Int) in
      guard self.started, self.generation == expectedGeneration else { return }
      self.cancelSilence()
      self.stopRequest = nil
      self.generation &+= 1
      self.resumeURL = resumeURL ?? self.resumeURL
      self.active = false
      self.started = false
      self.waitingFor = nil
      AudioServicesPlaySystemSound(1007)
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      self.removeRemoteCommands()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      self.postResumeNotification()
    }.runOnQueue(.main)

    AsyncFunction("stop") { (expectedGeneration: Int) in
      guard self.generation == expectedGeneration else { return }
      self.cancelSilence()
      self.sendNativeStop()
      self.generation &+= 1
      self.active = false
      self.started = false
      self.waitingFor = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      self.removeRemoteCommands()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }.runOnQueue(.main)

    OnDestroy {
      self.cancelSilence()
      self.sendNativeStop()
      self.generation &+= 1
      self.active = false
      self.removeRemoteCommands()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  private func sendNativeStop() {
    guard let request = stopRequest else { return }
    stopRequest = nil
    URLSession.shared.dataTask(with: request).resume()
  }

  private func cancelSilence() {
    silenceWorkItem?.cancel()
    silenceWorkItem = nil
    silenceGeneration = 0
  }

  private func activateAudio() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
    try session.setActive(true)
  }

  private func updateNowPlaying() {
    let title = active ? "Beeline Conversation" : "Waiting for \(waitingFor ?? "agent")…"
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: title,
      MPNowPlayingInfoPropertyIsLiveStream: true
    ]
    MPNowPlayingInfoCenter.default().playbackState = active ? .playing : .paused
  }

  private func refreshRemoteCommands() {
    removeRemoteCommands()
    installRemoteCommands()
  }

  private func installRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    let installedAt = generation
    stopCommand = center.stopCommand.addTarget { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.generation == installedAt else { return }
        self.sendNativeStop()
        self.sendEvent("stopRequested", ["generation": installedAt])
      }
      return .success
    }
    playCommand = center.playCommand.addTarget { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.started, self.generation == installedAt else { return }
        self.sendEvent("resumeRequested", ["generation": installedAt])
      }
      return .success
    }
    center.stopCommand.isEnabled = true
    center.playCommand.isEnabled = true
  }

  private func removeRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    if let target = stopCommand { center.stopCommand.removeTarget(target); stopCommand = nil }
    if let target = playCommand { center.playCommand.removeTarget(target); playCommand = nil }
    center.stopCommand.isEnabled = false
    center.playCommand.isEnabled = false
  }

  private func postResumeNotification() {
    let expectedGeneration = generation
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
      DispatchQueue.main.async {
      guard let self, granted, !self.started, self.generation == expectedGeneration else { return }
      let content = UNMutableNotificationContent()
      content.title = "Conversation ended"
      content.body = "Tap to restart Conversation"
      content.sound = .default
      content.userInfo = ["resumeUrl": self.resumeURL ?? ""]
      let request = UNNotificationRequest(identifier: "voice-background-audio-resume", content: content, trigger: nil)
      center.add(request)
      }
    }
  }
}
