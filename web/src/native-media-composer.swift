import Foundation
import AVFoundation

struct Insertion: Decodable { let atSeconds: Double; let sourceStartSeconds: Double; let durationSeconds: Double }
struct Request: Decodable { let sourcePath: String; let targetPath: String; let outputPath: String; let insertions: [Insertion] }
struct ComposeError: LocalizedError { let message: String; var errorDescription: String? { message } }
func time(_ value: Double) -> CMTime { CMTime(seconds: value, preferredTimescale: 60000) }

@main struct Composer {
  static func main() async {
    do {
      guard CommandLine.arguments.count == 2 else { throw ComposeError(message: "需要合成请求文件") }
      let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
      guard !request.insertions.isEmpty, request.insertions.count <= 100 else { throw ComposeError(message: "没有可插入片段或数量超过100") }
      let source = AVURLAsset(url: URL(fileURLWithPath: request.sourcePath))
      let target = AVURLAsset(url: URL(fileURLWithPath: request.targetPath))
      guard let sourceVideo = try await source.loadTracks(withMediaType: .video).first,
            let targetVideo = try await target.loadTracks(withMediaType: .video).first else { throw ComposeError(message: "两个输入都必须包含视频轨道") }
      let sourceDuration = try await source.load(.duration).seconds
      let targetDuration = try await target.load(.duration).seconds
      guard sourceDuration.isFinite, targetDuration.isFinite, sourceDuration > 0, targetDuration > 0 else { throw ComposeError(message: "输入视频时长无效") }
      let sourceAudio = try await source.loadTracks(withMediaType: .audio).first
      let targetAudio = try await target.loadTracks(withMediaType: .audio).first
      let composition = AVMutableComposition()
      guard let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
            let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw ComposeError(message: "无法创建合成轨道") }
      let targetSize = try await targetVideo.load(.naturalSize)
      let targetTransform = try await targetVideo.load(.preferredTransform)
      let targetBounds = CGRect(origin: .zero, size: targetSize).applying(targetTransform)
      let canvas = CGSize(width: max(2, floor(abs(targetBounds.width) / 2) * 2), height: max(2, floor(abs(targetBounds.height) / 2) * 2))
      var cursor = CMTime.zero
      var instructions: [AVVideoCompositionInstructionProtocol] = []
      func append(_ track: AVAssetTrack, _ sound: AVAssetTrack?, _ start: Double, _ duration: Double) async throws {
        guard duration > 0.0001 else { return }
        let range = CMTimeRange(start: time(start), duration: time(duration))
        try video.insertTimeRange(range, of: track, at: cursor)
        if let sound = sound {
          let available = try await sound.load(.timeRange)
          let overlap = CMTimeRangeGetIntersection(range, otherRange: available)
          if overlap.duration.seconds > 0 {
            try audio.insertTimeRange(overlap, of: sound, at: cursor + (overlap.start - range.start))
          }
        }
        let size = try await track.load(.naturalSize)
        let orientation = try await track.load(.preferredTransform)
        let bounds = CGRect(origin: .zero, size: size).applying(orientation)
        let scale = min(canvas.width / abs(bounds.width), canvas.height / abs(bounds.height))
        let transform = orientation.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
          .concatenating(CGAffineTransform(scaleX: scale, y: scale))
          .concatenating(CGAffineTransform(translationX: (canvas.width - abs(bounds.width) * scale) / 2, y: (canvas.height - abs(bounds.height) * scale) / 2))
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
        layer.setTransform(transform, at: cursor)
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: cursor, duration: range.duration)
        instruction.layerInstructions = [layer]
        instructions.append(instruction)
        cursor = cursor + range.duration
      }
      var position = 0.0
      for item in request.insertions.sorted(by: { $0.atSeconds < $1.atSeconds }) {
        guard item.atSeconds.isFinite, item.sourceStartSeconds.isFinite, item.durationSeconds.isFinite,
              item.atSeconds >= position, item.atSeconds <= targetDuration,
              item.sourceStartSeconds >= 0, item.durationSeconds > 0,
              item.sourceStartSeconds + item.durationSeconds <= sourceDuration + 0.01 else { throw ComposeError(message: "插入时间码超出真实视频时长") }
        try await append(targetVideo, targetAudio, position, item.atSeconds - position)
        try await append(sourceVideo, sourceAudio, item.sourceStartSeconds, min(item.durationSeconds, sourceDuration - item.sourceStartSeconds))
        position = item.atSeconds
      }
      try await append(targetVideo, targetAudio, position, targetDuration - position)
      let videoComposition = AVMutableVideoComposition()
      videoComposition.renderSize = canvas
      videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
      videoComposition.instructions = instructions
      guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality) else { throw ComposeError(message: "无法创建视频导出器") }
      session.videoComposition = videoComposition
      session.shouldOptimizeForNetworkUse = true
      let output = URL(fileURLWithPath: request.outputPath)
      try await session.export(to: output, as: .mp4)
      let delivered = AVURLAsset(url: output)
      let actualDuration = try await delivered.load(.duration).seconds
      let videos = try await delivered.loadTracks(withMediaType: .video)
      let audios = try await delivered.loadTracks(withMediaType: .audio)
      guard !videos.isEmpty, actualDuration.isFinite, abs(actualDuration - cursor.seconds) < 0.25,
            (sourceAudio == nil && targetAudio == nil) || !audios.isEmpty else { throw ComposeError(message: "成片轨道或时长验收失败") }
      let result: [String: Any] = ["status":"success", "durationSeconds":actualDuration, "expectedDurationSeconds":cursor.seconds, "insertedCount":request.insertions.count, "hasVideo":true, "hasAudio":!audios.isEmpty, "width":canvas.width, "height":canvas.height]
      print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    } catch {
      FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
      exit(1)
    }
  }
}
