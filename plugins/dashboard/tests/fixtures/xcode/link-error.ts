// Synthetic xcodebuild output in the real format, as a Bash tool result.
export default `Undefined symbols for architecture arm64:
  "static (extension in DemoKit):__C.NSBundle.demoResources.getter : __C.NSBundle", referenced from:
      protocol witness for Foundation.LocalizedError.errorDescription.getter : Swift.String? in conformance DemoExtension.Loader.LoadError : Foundation.LocalizedError in DemoExtension in Loader.o
ld: symbol(s) not found for architecture arm64
/work/DemoApp/DemoApp.xcodeproj: DemoExtension: clang: error: linker command failed with exit code 1 (use -v to see invocation)

SwiftDriver RenderCore normal arm64 com.apple.xcode.tools.swift.compiler (in target 'RenderCore' from project 'RenderCore')
`
