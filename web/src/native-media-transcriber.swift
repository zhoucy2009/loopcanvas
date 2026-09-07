import AVFAudio
import CoreMedia
import Foundation
import Speech

struct Segment: Codable {
    let text: String
    let startSeconds: Double
    let durationSeconds: Double
}

struct Output: Codable {
    let status: String
    let locale: String
    let text: String
    let segments: [Segment]
    let installedLanguageAsset: Bool
}

@main
struct MediaTranscriber {
    static func main() async {
        do {
            guard #available(macOS 26.0, *) else {
                throw NSError(domain: "LoopCanvas", code: 1, userInfo: [NSLocalizedDescriptionKey: "本机转写需要 macOS 26 或更高版本。"])
            }
            guard CommandLine.arguments.count >= 2 else {
                throw NSError(domain: "LoopCanvas", code: 2, userInfo: [NSLocalizedDescriptionKey: "缺少音频文件路径。"])
            }
            let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
            let requestedLocale = Locale(identifier: CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "zh-CN")
            guard SpeechTranscriber.isAvailable,
                  let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
                throw NSError(domain: "LoopCanvas", code: 3, userInfo: [NSLocalizedDescriptionKey: "本机语音转写不支持所选语言。"])
            }

            let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedTranscriptionWithAlternatives)
            var installedLanguageAsset = false
            let assetStatus = await AssetInventory.status(forModules: [transcriber])
            if assetStatus != .installed {
                guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
                    throw NSError(domain: "LoopCanvas", code: 4, userInfo: [NSLocalizedDescriptionKey: "无法取得本机语音模型。请在联网后重试，以便 macOS 下载语言资源；媒体内容不会上传。"])
                }
                try await request.downloadAndInstall()
                installedLanguageAsset = true
            }

            let audioFile = try AVAudioFile(forReading: inputURL)
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            let resultTask = Task<[Segment], Error> {
                var segments: [Segment] = []
                for try await result in transcriber.results {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { continue }
                    segments.append(Segment(
                        text: text,
                        startSeconds: CMTimeGetSeconds(result.range.start),
                        durationSeconds: CMTimeGetSeconds(result.range.duration)
                    ))
                }
                return segments
            }
            try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
            let segments = try await resultTask.value
            let text = segments.map(\.text).joined(separator: "\n")
            guard !text.isEmpty else {
                throw NSError(domain: "LoopCanvas", code: 5, userInfo: [NSLocalizedDescriptionKey: "本机转写完成，但没有识别到语音。"])
            }
            let output = Output(status: "success", locale: locale.identifier, text: text, segments: segments, installedLanguageAsset: installedLanguageAsset)
            let data = try JSONEncoder().encode(output)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        } catch {
            FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
            Foundation.exit(1)
        }
    }
}
