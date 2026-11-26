Pod::Spec.new do |s|
  s.name           = 'DocumentScanner'
  s.version        = '1.0.0'
  s.summary        = 'VisionKit document scanner for Poke'
  s.author         = ''
  s.homepage       = 'https://poke.arham.im'
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'VisionKit', 'PDFKit'
  s.source_files   = '**/*.swift'
end
