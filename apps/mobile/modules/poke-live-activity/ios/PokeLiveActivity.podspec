Pod::Spec.new do |s|
  s.name           = 'PokeLiveActivity'
  s.version        = '1.0.0'
  s.summary        = 'Starts, updates and ends the Live Activity for a Poke task'
  s.author         = ''
  s.homepage       = 'https://poke.arham.im'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'ActivityKit'
  s.source_files   = '**/*.swift'
end
