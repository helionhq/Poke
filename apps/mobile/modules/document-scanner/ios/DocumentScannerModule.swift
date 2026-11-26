import ExpoModulesCore
import PDFKit
import VisionKit

/// VisionKit's document camera (brief §20.2, "Scan Document"). Every scanned page goes into one
/// PDF in the caches directory; the app uploads it like any other file.
public class DocumentScannerModule: Module {
  private var delegate: ScanDelegate?

  public func definition() -> ModuleDefinition {
    Name("DocumentScanner")

    Function("isAvailable") { () -> Bool in
      VNDocumentCameraViewController.isSupported
    }

    AsyncFunction("scan") { (promise: Promise) in
      guard VNDocumentCameraViewController.isSupported else {
        promise.resolve(nil)
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("E_NO_VIEW", "Couldn't open the scanner")
        return
      }
      let controller = VNDocumentCameraViewController()
      let delegate = ScanDelegate { [weak self] result in
        controller.dismiss(animated: true) {
          switch result {
          case .success(let value): promise.resolve(value)
          case .failure(let error): promise.reject("E_SCAN", error.localizedDescription)
          }
          self?.delegate = nil
        }
      }
      self.delegate = delegate
      controller.delegate = delegate
      presenter.present(controller, animated: true)
    }.runOnQueue(.main)
  }
}

private final class ScanDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
  private let done: (Result<[String: Any]?, Error>) -> Void

  init(done: @escaping (Result<[String: Any]?, Error>) -> Void) {
    self.done = done
  }

  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
    done(.success(nil))
  }

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
    done(.failure(error))
  }

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
    let pdf = PDFDocument()
    for index in 0..<scan.pageCount {
      if let page = PDFPage(image: scan.imageOfPage(at: index)) {
        pdf.insert(page, at: pdf.pageCount)
      }
    }
    let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("scan-\(UUID().uuidString).pdf")
    if pdf.write(to: url) {
      done(.success(["uri": url.absoluteString, "pages": scan.pageCount]))
    } else {
      done(.failure(NSError(domain: "DocumentScanner", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't save the scan"])))
    }
  }
}
