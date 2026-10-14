require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name           = 'VoiceBackgroundAudio'
  s.version        = package['version']
  s.summary        = 'Native lifecycle support for Beeline voice conversation'
  s.description    = 'Background audio session and lock-screen controls for voice conversation.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Beeline'
  s.homepage       = 'https://usebeeline.app'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/Beeline-Work/beeline.git', :tag => s.version.to_s }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
