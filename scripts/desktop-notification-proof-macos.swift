import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count == 2,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    fputs("Cannot read the macOS desktop screenshot\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(cgImage: cgImage).perform([request])
let visible = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
print("Visible desktop text: \(visible)")
guard visible.contains("Safe test fixture") else {
    fputs("Native fixture notification is not visible in the macOS screenshot\n", stderr)
    exit(1)
}
