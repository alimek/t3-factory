# Changelog

## [0.4.0](https://github.com/alimek/t3-factory/compare/v0.3.0...v0.4.0) (2026-11-10)


### Features

* browse retained Run images from the Flow input block ([#137](https://github.com/alimek/t3-factory/issues/137)) ([8804b09](https://github.com/alimek/t3-factory/commit/8804b098e553c3394c025d743294e3eb599db9c3))
* declare exits on Agents; Flows only wire ([#152](https://github.com/alimek/t3-factory/issues/152)) ([28c8cbd](https://github.com/alimek/t3-factory/commit/28c8cbdcc2285e913197e741b5afbf35a630ba5e))
* drop three retired history tables ([#207](https://github.com/alimek/t3-factory/issues/207)) ([c35dcf4](https://github.com/alimek/t3-factory/commit/c35dcf4077cd1b3974abbf100327244c7f33eb8e))
* Factory MCP authoring tools for Agents and Flows ([#225](https://github.com/alimek/t3-factory/issues/225)) ([0c1cb8d](https://github.com/alimek/t3-factory/commit/0c1cb8d6c587cedbfc6db5108c372d9c08cacb96))
* generate and gate a current-schema snapshot beside the migrations ([#208](https://github.com/alimek/t3-factory/issues/208)) ([c742def](https://github.com/alimek/t3-factory/commit/c742def971cd0ff5950ede21996b41bc7e1956c9))
* let every worker retrieve original Run images through Factory MCP ([#136](https://github.com/alimek/t3-factory/issues/136)) ([cd0d25d](https://github.com/alimek/t3-factory/commit/cd0d25daf1b35326d0f49846ba89421eeea7b667))
* paste and reference screenshots inside the Run prompt ([#135](https://github.com/alimek/t3-factory/issues/135)) ([a644f68](https://github.com/alimek/t3-factory/commit/a644f684d47b9177bab528ea8f9985213653b5ed))
* resize the sidebar and Run side panel ([#149](https://github.com/alimek/t3-factory/issues/149)) ([4512876](https://github.com/alimek/t3-factory/commit/4512876eb951ed2c14012d2dee7e6382f9b4b8d2))
* Run canvas focuses and follows the active Block ([#129](https://github.com/alimek/t3-factory/issues/129)) ([60d07fc](https://github.com/alimek/t3-factory/commit/60d07fc7cd4407447ffd013a513de17b2e8fb1b6))
* settle T3 worker threads after each finished Block ([#127](https://github.com/alimek/t3-factory/issues/127)) ([7de9093](https://github.com/alimek/t3-factory/commit/7de9093901742d19585ea6ff5d60b36f67659d08))
* share the UI evidence validator and document the evidence workflow ([#151](https://github.com/alimek/t3-factory/issues/151)) ([020ee2a](https://github.com/alimek/t3-factory/commit/020ee2a33b3d84d5144c9ca6ee2ab4782c68c4bc))
* show the Run number as a #N pill in sidebar, top bar and palette ([#141](https://github.com/alimek/t3-factory/issues/141)) ([38b2915](https://github.com/alimek/t3-factory/commit/38b2915bc43a1f60c9c73dbd728b47047a19af56))
* start Runs with persistent screenshot attachments ([#134](https://github.com/alimek/t3-factory/issues/134)) ([90bb5a5](https://github.com/alimek/t3-factory/commit/90bb5a51df02123a491d4537d48bb18c36e2ac67))


### Bug Fixes

* **desktop:** declare the current live protocol in the packaged-app probe ([#213](https://github.com/alimek/t3-factory/issues/213)) ([4d916d7](https://github.com/alimek/t3-factory/commit/4d916d74ebc0c30638c624dd01bb0a8b44c0ac1d))
* **desktop:** enable Cmd+R reload in packaged builds ([#142](https://github.com/alimek/t3-factory/issues/142)) ([e5273d1](https://github.com/alimek/t3-factory/commit/e5273d152f5bc8fef63681648f882408ed6ec1d5))
* launch a worktree Run's later Block workers only when reached ([#133](https://github.com/alimek/t3-factory/issues/133)) ([ea3d825](https://github.com/alimek/t3-factory/commit/ea3d825ca61b8ee91832027d677144f4f1a4b7bb))
* make the app icon read as large as other macOS Dock icons ([#150](https://github.com/alimek/t3-factory/issues/150)) ([069d3da](https://github.com/alimek/t3-factory/commit/069d3da53f630e1d025ed2ee4039793b685964c0))
* place the prompt caret at the end when opening a Draft ([#153](https://github.com/alimek/t3-factory/issues/153)) ([f871148](https://github.com/alimek/t3-factory/commit/f87114805bfa95fae883145863f933e3004d9928))

## [0.3.0](https://github.com/alimek/t3-factory/compare/v0.2.0...v0.3.0) (2026-11-08)


### ⚠ BREAKING CHANGES

* remove Run again and snapshot-based Start ([#29](https://github.com/alimek/t3-factory/issues/29))

### Features

* accept Cursor and Grok Factory reporting ([#41](https://github.com/alimek/t3-factory/issues/41)) ([1d51a9a](https://github.com/alimek/t3-factory/commit/1d51a9aa6d452fcd76d6c9d5abca32a1be417a34))
* add static landing page deployed to GitHub Pages on Release ([#105](https://github.com/alimek/t3-factory/issues/105)) ([d69414c](https://github.com/alimek/t3-factory/commit/d69414c6427bac6fc6bc9d2149b8eadae63c800c))
* immutable Flow and Agent revisions (spec [#19](https://github.com/alimek/t3-factory/issues/19)) ([#38](https://github.com/alimek/t3-factory/issues/38)) ([d4c301b](https://github.com/alimek/t3-factory/commit/d4c301b4c1bb70a9fb84d105b366a7515d66feb1))
* improve Run sidebar previews and branch/PR metadata ([#93](https://github.com/alimek/t3-factory/issues/93)) ([a89c830](https://github.com/alimek/t3-factory/commit/a89c8306d9825c142972a11e476b734282b7f45a))
* native desktop menu synced with the shortcut registry ([#111](https://github.com/alimek/t3-factory/issues/111)) ([cb07e7e](https://github.com/alimek/t3-factory/commit/cb07e7e00eba286aaeae8bb08cc49fe14f7b4033))
* persist local Run drafts ([#30](https://github.com/alimek/t3-factory/issues/30)) ([814032b](https://github.com/alimek/t3-factory/commit/814032b5e7807b3987aedcb75bd571c95158c4b9))
* platform keyboard shortcuts, navigation and cheat sheet ([#87](https://github.com/alimek/t3-factory/issues/87)) ([ae96763](https://github.com/alimek/t3-factory/commit/ae967630ee15f02efcdb961a814aba50d35ca533))
* remove Run again and snapshot-based Start ([#29](https://github.com/alimek/t3-factory/issues/29)) ([d4c7898](https://github.com/alimek/t3-factory/commit/d4c78983051421ed47ab30bb5575ad8dc1143261))
* replace Run composer polling with a live launch-choices scope ([#89](https://github.com/alimek/t3-factory/issues/89)) ([30a686d](https://github.com/alimek/t3-factory/commit/30a686d4f05a459eba56ac68ec0733f37373f863))
* replace Run screen polling with scoped live subscriptions ([#85](https://github.com/alimek/t3-factory/issues/85)) ([57cd410](https://github.com/alimek/t3-factory/commit/57cd410053c2b3126ff66894dedaf6b7086b2b31))
* report only working and finished from Factory workers ([#68](https://github.com/alimek/t3-factory/issues/68)) ([99cedb6](https://github.com/alimek/t3-factory/commit/99cedb6d30e745eb2cd37277aa5a7d552d8c539c))
* serve Factory MCP over HTTP instead of a per-harness stdio bridge ([#47](https://github.com/alimek/t3-factory/issues/47)) ([e578cbf](https://github.com/alimek/t3-factory/commit/e578cbfff2418eb0335b7ea22fe5617cb8e7218a))
* shared Run workspace chosen by the Flow ([#99](https://github.com/alimek/t3-factory/issues/99)) ([25ce499](https://github.com/alimek/t3-factory/commit/25ce499e8e6dfb33767a53233658e5e062707349))
* treat each Block as its worker thread ([#65](https://github.com/alimek/t3-factory/issues/65)) ([3d97ff1](https://github.com/alimek/t3-factory/commit/3d97ff16df8cad32788b77d6cad906348435c756))


### Bug Fixes

* allow approved clients to install Factory MCP ([#48](https://github.com/alimek/t3-factory/issues/48)) ([ebcb8ff](https://github.com/alimek/t3-factory/commit/ebcb8ff75c04d1cbc493e081bc158d2b8ba2b519))
* enforce attribution-free commits and clarify agent work state ([#50](https://github.com/alimek/t3-factory/issues/50)) ([1953182](https://github.com/alimek/t3-factory/commit/1953182dad062ce505db12a2d88bb9edfd997680))
* explain rejected reports and guard report recovery ([#53](https://github.com/alimek/t3-factory/issues/53)) ([4b4f931](https://github.com/alimek/t3-factory/commit/4b4f9311fcd317bf0b609aceae37b1ed042444b9))
* hide empty Run groups and flatten sidebar search ([#66](https://github.com/alimek/t3-factory/issues/66)) ([ff86430](https://github.com/alimek/t3-factory/commit/ff864302b464396db836fd265252966f3e4093da))
* preserve worker progress across delegated continuations ([#49](https://github.com/alimek/t3-factory/issues/49)) ([0d109e7](https://github.com/alimek/t3-factory/commit/0d109e7a186ad93619c06ab06820a276835273fe))
* release results after native subagents settle ([#56](https://github.com/alimek/t3-factory/issues/56)) ([38eba66](https://github.com/alimek/t3-factory/commit/38eba6649148b21065d9afd3fa167de80f1fd33a))
* report whole Flow blockers and verify native UI evidence ([#52](https://github.com/alimek/t3-factory/issues/52)) ([d905534](https://github.com/alimek/t3-factory/commit/d905534de2a6f8249ef40eb37bb300a343c74a3d))
* retain worker report authority across user replies ([#43](https://github.com/alimek/t3-factory/issues/43)) ([b533562](https://github.com/alimek/t3-factory/commit/b5335622240427c8ba31789b3e8eb407fff25296))
* retrieve worker inputs and exact incoming results ([#45](https://github.com/alimek/t3-factory/issues/45)) ([40d504b](https://github.com/alimek/t3-factory/commit/40d504b6cf2a609641417e9000fbba93018a5942))
* show per-provider reporting support and link Start to Agent reporting ([#39](https://github.com/alimek/t3-factory/issues/39)) ([e90302b](https://github.com/alimek/t3-factory/commit/e90302b7343aac787c27ff733ced59ac9dbeaec7))
* simplify sidebar footer controls ([#55](https://github.com/alimek/t3-factory/issues/55)) ([ada552c](https://github.com/alimek/t3-factory/commit/ada552cb0e519ad955b115b82674ca83ecaea4c3))
* surface Agent reporting problems before starting Runs ([#44](https://github.com/alimek/t3-factory/issues/44)) ([9b3cbfe](https://github.com/alimek/t3-factory/commit/9b3cbfeb0152eb4eba7313901b329aff81d49b4b))
* take the beta draft id from the create response ([#40](https://github.com/alimek/t3-factory/issues/40)) ([1de9434](https://github.com/alimek/t3-factory/commit/1de94345caff0a91b95e58e4663d30c3b5def24f))
* wrap long ids and trim duplicates in block details ([#46](https://github.com/alimek/t3-factory/issues/46)) ([0b01819](https://github.com/alimek/t3-factory/commit/0b01819adf816af36bd9d0699e8c2e47bc69e957))

## [0.2.0](https://github.com/alimek/t3-factory/compare/v0.1.0...v0.2.0) (2026-11-07)


### Features

* add beta desktop channel and client-triggered server updates ([#21](https://github.com/alimek/t3-factory/issues/21)) ([8b2c93d](https://github.com/alimek/t3-factory/commit/8b2c93d40333f39344a2fca8214235c84d5b0903))
* launch Block workers directly instead of a Run conversation ([#20](https://github.com/alimek/t3-factory/issues/20)) ([2f09034](https://github.com/alimek/t3-factory/commit/2f090346418a9abde65d2a69aa89c7262cdcf15c))


### Bug Fixes

* resume waiting workers after native user replies ([#16](https://github.com/alimek/t3-factory/issues/16)) ([acf8615](https://github.com/alimek/t3-factory/commit/acf86151cb632f1187adba25b7fa2fe6ea16fcde))


### Performance Improvements

* **frontend:** remove the dynamic Lucide project icon catalog ([#14](https://github.com/alimek/t3-factory/issues/14)) ([b364947](https://github.com/alimek/t3-factory/commit/b3649474a5b0edf19eb6247c7db3679d6e38bd8a))

## 0.1.0 (2026-11-06)


### Features

* release T3 Factory through release-please with signed macOS downloads ([#12](https://github.com/alimek/t3-factory/issues/12)) ([366b1da](https://github.com/alimek/t3-factory/commit/366b1daaca43397bc7e37d3424695d91e647f6a6))
