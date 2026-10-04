// Synthetic xcodebuild output in the real format, as a Bash tool result.
export default `Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild build -project DemoApp.xcodeproj -scheme DemoApp -configuration Debug -destination platform=macOS,arch=arm64 -derivedDataPath /tmp/demoapp-build

Resolve Package Graph


Resolved source packages:
  RenderCore: /work/DemoApp/Packages/RenderCore @ local
  DemoKit: /work/DemoApp/Packages/DemoKit @ local

ComputePackagePrebuildTargetDependencyGraph

Prepare packages

CreateBuildRequest

SendProjectDescription

CreateBuildOperation

ComputeTargetDependencyGraph
note: Building targets in dependency order
note: Target dependency graph (4 targets)
    Target 'DemoApp' in project 'DemoApp'
        ➜ Explicit dependency on target 'DemoExtension' in project 'DemoApp'
        ➜ Explicit dependency on target 'RenderCore' in project 'RenderCore'
    Target 'RenderCore' in project 'RenderCore'
        ➜ Explicit dependency on target 'DemoKit' in project 'DemoKit'
    Target 'DemoKit' in project 'DemoKit' (no dependencies)
    Target 'DemoExtension' in project 'DemoApp' (no dependencies)

GatherProvisioningInputs

CreateBuildDescription

ClangStatCache /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang-stat-cache /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk /tmp/demoapp-build/SDKStatCaches.noindex/macosx-0000000000000000000000000000000000000000000000000000000000000000.sdkstatcache
    cd /work/DemoApp/DemoApp.xcodeproj
    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang-stat-cache /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk -o /tmp/demoapp-build/SDKStatCaches.noindex/macosx-0000000000000000000000000000000000000000000000000000000000000000.sdkstatcache

Copy /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/PlugIns/DemoExtension.appex /tmp/demoapp-build/Build/Products/Debug/DemoExtension.appex (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp
    builtin-copy -exclude .DS_Store -exclude CVS -exclude .svn -exclude .git -exclude .hg -resolve-src-symlinks /tmp/demoapp-build/Build/Products/Debug/DemoExtension.appex /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/PlugIns

ProcessInfoPlistFile /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/Info.plist /work/DemoApp/DemoApp/Info.plist (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp
    builtin-infoPlistUtility /work/DemoApp/DemoApp/Info.plist -producttype com.apple.product-type.application -genpkginfo /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/PkgInfo -expandbuildsettings -platform macosx -o /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/Info.plist

CopySwiftLibs /tmp/demoapp-build/Build/Products/Debug/DemoApp.app (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp
    builtin-swiftStdLibTool --copy --verbose --scan-executable /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/MacOS/DemoApp.debug.dylib --scan-folder /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/Frameworks --scan-folder /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/PlugIns --platform macosx --toolchain /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain --destination /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/Frameworks --strip-bitcode --strip-bitcode-tool /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/bitcode_strip --emit-dependency-info /tmp/demoapp-build/Build/Intermediates.noindex/DemoApp.build/Debug/DemoApp.build/SwiftStdLibToolInputDependencies.dep --filter-for-swift-os

CodeSign /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/MacOS/DemoApp.debug.dylib (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp

    Signing Identity:     "Apple Development: dev@example.com (TEAM000000)"

    /usr/bin/codesign --force --sign 0000000000000000000000000000000000000000 --timestamp\\=none --generate-entitlement-der /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/MacOS/DemoApp.debug.dylib
/tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/MacOS/DemoApp.debug.dylib: replacing existing signature

CodeSign /tmp/demoapp-build/Build/Products/Debug/DemoApp.app (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp

    Signing Identity:     "Apple Development: dev@example.com (TEAM000000)"

    /usr/bin/codesign --force --sign 0000000000000000000000000000000000000000 --entitlements /tmp/demoapp-build/Build/Intermediates.noindex/DemoApp.build/Debug/DemoApp.build/DemoApp.app.xcent --timestamp\\=none --generate-entitlement-der /tmp/demoapp-build/Build/Products/Debug/DemoApp.app
/tmp/demoapp-build/Build/Products/Debug/DemoApp.app: replacing existing signature

Validate /tmp/demoapp-build/Build/Products/Debug/DemoApp.app (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp
    builtin-validationUtility /tmp/demoapp-build/Build/Products/Debug/DemoApp.app -no-validate-extension -infoplist-subpath Contents/Info.plist

RegisterWithLaunchServices /tmp/demoapp-build/Build/Products/Debug/DemoApp.app (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp
    builtin-lsregisterurl --record-path /tmp/demoapp-build/Build/Intermediates.noindex/XCBuildData/registered-launchservices.txt -- /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister -f -R -trusted /tmp/demoapp-build/Build/Products/Debug/DemoApp.app

ValidateEmbeddedBinary /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/PlugIns/DemoExtension.appex (in target 'DemoApp' from project 'DemoApp')
    cd /work/DemoApp
    /Applications/Xcode.app/Contents/Developer/usr/bin/embeddedBinaryValidationUtility /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/PlugIns/DemoExtension.appex -signing-cert 0000000000000000000000000000000000000000 -info-plist-path /tmp/demoapp-build/Build/Products/Debug/DemoApp.app/Contents/Info.plist
warning: The CFBundleShortVersionString of an app extension ('1.1') must match that of its containing parent app ('1.0').
warning: The CFBundleVersion of an app extension ('7') must match that of its containing parent app ('3').

PruneExplicitPrecompiledModules /tmp/demoapp-build/SDKExplicitPrecompiledModules

PruneExplicitPrecompiledModules /tmp/demoapp-build/Build/Intermediates.noindex/ExplicitPrecompiledModules

** BUILD SUCCEEDED **
`
