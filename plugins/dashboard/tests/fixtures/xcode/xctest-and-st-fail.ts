// Synthetic xcodebuild output in the real format, as a Bash tool result.
export default `	 Executed 20 tests, with 0 failures (0 unexpected) in 0.100 (0.100) seconds
	 Executed 40 tests, with 0 failures (0 unexpected) in 0.020 (0.020) seconds
	 Executed 30 tests, with 0 failures (0 unexpected) in 0.010 (0.010) seconds
	 Executed 25 tests, with 0 failures (0 unexpected) in 0.010 (0.010) seconds
	 Executed 15 tests, with 0 failures (0 unexpected) in 0.010 (0.010) seconds
	 Executed 35 tests, with 0 failures (0 unexpected) in 0.030 (0.030) seconds
/work/DemoApp/DemoAppTests/RenderCoreTests.swift:120: error: -[DemoAppTests.RenderCoreTests testEmptySceneDrawsBackground] : XCTAssertGreaterThan failed: ("0") is not greater than ("100") - nothing was drawn
	 Executed 10 tests, with 1 failure (0 unexpected) in 10.000 (10.000) seconds
	 Executed 5 tests, with 0 failures (0 unexpected) in 5.000 (5.000) seconds
	 Executed 180 tests, with 1 failure (0 unexpected) in 15.200 (15.200) seconds
	 Executed 180 tests, with 1 failure (0 unexpected) in 15.200 (15.300) seconds
􀢄 Test "Every catalog entry has a value for each supported language" recorded an issue at CatalogCoverageTests.swift:20:9: Expectation failed: missing.isEmpty
􀢄 Test "Every catalog entry has a value for each supported language" recorded an issue at CatalogCoverageTests.swift:20:9: Expectation failed: missing.isEmpty
􀢄 Test "The catalog keeps no stale entries" recorded an issue at CatalogCoverageTests.swift:60:9: Expectation failed: stale.isEmpty
􀢄 Test "Two requests for one key share a single download" recorded an issue at DownloaderTests.swift:100:9: Expectation failed: await waitUntil { counter.count("fetch") >= 1 }
􀢄 Test "Two requests for one key share a single download" recorded an issue at DownloaderTests.swift:105:9: Expectation failed: counter.count("fetch") == 1
􀢄 Test "A failed download is not retried before its back-off ends" recorded an issue at DownloaderTests.swift:140:9: Expectation failed: counter.count("fetch") == 2
􀢄 Test "A failed download is not retried before its back-off ends" recorded an issue at DownloaderTests.swift:145:9: Expectation failed: counter.count("fetch") == 3
􀢄 Test "A download finishing after cancel publishes nothing" recorded an issue at DownloaderTests.swift:200:9: Expectation failed: sink.values.isEmpty
􀢄 Test "A URL outside the allowed hosts is never requested" recorded an issue at DownloaderTests.swift:240:9: Expectation failed: await downloader.data(for: url) == nil
􀢄 Test "A URL outside the allowed hosts is never requested" recorded an issue at DownloaderTests.swift:241:9: Expectation failed: counter.count("fetch") == 0
􀢄 Test run with 2400 tests in 300 suites failed after 60.000 seconds with 10 issues.
`
