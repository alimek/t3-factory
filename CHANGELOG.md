# Changelog

## [0.10.0](https://github.com/alimek/t3-factory/compare/v0.9.0...v0.10.0) (2026-11-21)


### Features

* **runs:** copy the Run number and Run ID from Run menus ([#660](https://github.com/alimek/t3-factory/issues/660)) ([4368383](https://github.com/alimek/t3-factory/commit/436838374f669ba1d43c4f76bca72b4590511ce0))


### Bug Fixes

* **desktop:** restore the window's last size and position ([#655](https://github.com/alimek/t3-factory/issues/655)) ([7a9de93](https://github.com/alimek/t3-factory/commit/7a9de93e28deac8462a9428360b20bb2b83f5c45))

## [0.9.0](https://github.com/alimek/t3-factory/compare/v0.8.0...v0.9.0) (2026-11-21)


### Features

* **agents:** Project overrides of a global Agent's Worker ([#491](https://github.com/alimek/t3-factory/issues/491)) ([cc114af](https://github.com/alimek/t3-factory/commit/cc114afc488fc1b32356bbe2ddb09c33ec68fc57))
* **appearance:** follow the system appearance by default ([#513](https://github.com/alimek/t3-factory/issues/513)) ([#590](https://github.com/alimek/t3-factory/issues/590)) ([dda7ee3](https://github.com/alimek/t3-factory/commit/dda7ee308b06fd754d23cab97d9c45789e76f276))
* **definitions:** Project-owned Flows and Agents ([#484](https://github.com/alimek/t3-factory/issues/484)) ([3e29672](https://github.com/alimek/t3-factory/commit/3e2967244fcf5eac8a8d7633f82c92a79c02f2c8))
* **e2e:** contact-sheet diff for Before/After UI evidence ([#592](https://github.com/alimek/t3-factory/issues/592)) ([603c29e](https://github.com/alimek/t3-factory/commit/603c29ee4692806c7e8c1961cafc8e89f52a0858))
* **flows:** expose Run id/startedAt in factory_get_run and add fresh-context revisits ([#645](https://github.com/alimek/t3-factory/issues/645)) ([05307af](https://github.com/alimek/t3-factory/commit/05307afc728829cc05dc1d5ff572d8dfbe199cdc))
* **flows:** Finish block with named endings and one Run result ([#634](https://github.com/alimek/t3-factory/issues/634)) ([aae6cb1](https://github.com/alimek/t3-factory/commit/aae6cb14d85689b1172ebf39aaf3770226cc912c))
* **pr:** show UI evidence as a side-by-side Before | After table ([#568](https://github.com/alimek/t3-factory/issues/568)) ([2efefee](https://github.com/alimek/t3-factory/commit/2efefee35e7770a3897c0f2208c9efd8efaf3a87))
* **reporting:** install Factory reporting for Antigravity ([#635](https://github.com/alimek/t3-factory/issues/635)) ([c2ba340](https://github.com/alimek/t3-factory/commit/c2ba340552660ff783f350febe0ebab36b0f7d3d))
* **reporting:** install Factory reporting for Mistral Vibe ([#641](https://github.com/alimek/t3-factory/issues/641)) ([f9c0cae](https://github.com/alimek/t3-factory/commit/f9c0caefb131dc0fe25348330aed4db327734e86))
* **runner:** synchronize T3 worker titles with Runs ([#643](https://github.com/alimek/t3-factory/issues/643)) ([8cda5fc](https://github.com/alimek/t3-factory/commit/8cda5fcca86cf18cf7314b692e23db282d650a01))
* **runs:** highlight a card's outgoing connections on the Execution canvas ([#521](https://github.com/alimek/t3-factory/issues/521)) ([#576](https://github.com/alimek/t3-factory/issues/576)) ([7ff59bf](https://github.com/alimek/t3-factory/commit/7ff59bffa0ba867665b8e29be29bc8ddd81aef68))
* **runs:** render Agent-written text as Markdown, with readable Needs input cards ([#541](https://github.com/alimek/t3-factory/issues/541)) ([#554](https://github.com/alimek/t3-factory/issues/554)) ([6ced339](https://github.com/alimek/t3-factory/commit/6ced3394fd1f3f6a5ed6ba869cd3b61b221b45c7))
* **runs:** surface overdue Block progress and warn before starting completed issues ([#596](https://github.com/alimek/t3-factory/issues/596)) ([8fd72ca](https://github.com/alimek/t3-factory/commit/8fd72ca5d979b3f7d72e1f765aed7a851a844b00))
* **setup:** guided First-run setup for T3 connection and agent install ([#606](https://github.com/alimek/t3-factory/issues/606)) ([69bbf92](https://github.com/alimek/t3-factory/commit/69bbf922bee7b5f6071999e94f3d81e407789cef))
* **studio:** quieter Agent editor with a header model picker, and a tidier Flow library ([#497](https://github.com/alimek/t3-factory/issues/497)) ([91b29b9](https://github.com/alimek/t3-factory/commit/91b29b9c24577bff575e7c36c5f13b7e9e47f466))
* **triggers:** Factory MCP tools to inspect, manage and check Triggers ([#616](https://github.com/alimek/t3-factory/issues/616)) ([d05c9de](https://github.com/alimek/t3-factory/commit/d05c9de00acaec10492a7a43e88afcf0e6b6bc3e))
* **triggers:** start Runs from GitHub issues marked ready ([#485](https://github.com/alimek/t3-factory/issues/485)) ([af27f14](https://github.com/alimek/t3-factory/commit/af27f143d7154f97a62c96268d3f6a5d389ad20f))
* **ui:** ChoiceMenu for every dropdown and SecretField for the address-changed key ([#534](https://github.com/alimek/t3-factory/issues/534)) ([#562](https://github.com/alimek/t3-factory/issues/562)) ([cd268e6](https://github.com/alimek/t3-factory/commit/cd268e6f5331dfafc133962198b73c60258ce720))
* **ui:** one design system across Runs, Studio and Settings (UI review [#506](https://github.com/alimek/t3-factory/issues/506)) ([#539](https://github.com/alimek/t3-factory/issues/539)) ([d56e551](https://github.com/alimek/t3-factory/commit/d56e5515888d9846cc3058898613386f15b38d71))
* **ui:** one shared EmptyState for every dashed empty state ([#535](https://github.com/alimek/t3-factory/issues/535)) ([#569](https://github.com/alimek/t3-factory/issues/569)) ([087bb97](https://github.com/alimek/t3-factory/commit/087bb97d48c3662d65cb438b3df7eda5c7a9ae08))
* **ui:** one shared focus ring and a NavRow primitive ([#532](https://github.com/alimek/t3-factory/issues/532)) ([#591](https://github.com/alimek/t3-factory/issues/591)) ([03234c1](https://github.com/alimek/t3-factory/commit/03234c10bccb172d6a7c43ed74a940eaa6625985))
* **ui:** one shared Studio editor header ([#533](https://github.com/alimek/t3-factory/issues/533)) ([#561](https://github.com/alimek/t3-factory/issues/561)) ([d48762f](https://github.com/alimek/t3-factory/commit/d48762f2cf70e03925a028128b412dbed4733634))
* **ui:** one shared TextLink for text links and link-style actions ([#531](https://github.com/alimek/t3-factory/issues/531)) ([#553](https://github.com/alimek/t3-factory/issues/553)) ([9e08e58](https://github.com/alimek/t3-factory/commit/9e08e58db2552195c6795690c6bf2aadd4ade27d))
* **ui:** one Surface primitive for bordered cards and containers ([#538](https://github.com/alimek/t3-factory/issues/538)) ([#577](https://github.com/alimek/t3-factory/issues/577)) ([d06b2d4](https://github.com/alimek/t3-factory/commit/d06b2d40ecbb5cf29bceae028d635a3efff69289))
* **ui:** shortcuts sheet on the shared wide dialog size ([#537](https://github.com/alimek/t3-factory/issues/537)) ([#570](https://github.com/alimek/t3-factory/issues/570)) ([9a0d6eb](https://github.com/alimek/t3-factory/commit/9a0d6eb555d4709c858d6cd9d6fc892388602ea0))
* **ui:** TextLink takes any trailing icon; reader links on TextLink; drop Button link variant ([#552](https://github.com/alimek/t3-factory/issues/552)) ([#588](https://github.com/alimek/t3-factory/issues/588)) ([301f64c](https://github.com/alimek/t3-factory/commit/301f64c36a9a1c82ef6b5a3897da7e0c104c12ed))


### Bug Fixes

* **backend:** prevent T3 schema validator memory growth ([#540](https://github.com/alimek/t3-factory/issues/540)) ([4821b91](https://github.com/alimek/t3-factory/commit/4821b9106579c4d9526f4c3d377b3c9bb781a8da))
* **backend:** release expired request and operation state ([#546](https://github.com/alimek/t3-factory/issues/546)) ([581a5e0](https://github.com/alimek/t3-factory/commit/581a5e027cd790891490e58ef29fa60ec50eb9d2))
* **canvas:** draw selected authoring blocks and image prompts at their reserved height ([#503](https://github.com/alimek/t3-factory/issues/503)) ([a529bef](https://github.com/alimek/t3-factory/commit/a529befbab7e975d85aca4357ab1fcd70df5cb87))
* **ci:** pass comment ratchet base in beta and desktop build workflows ([#631](https://github.com/alimek/t3-factory/issues/631)) ([5411ef1](https://github.com/alimek/t3-factory/commit/5411ef17547ecc756bd8b6fa94bdcbb2cf16d583))
* **desktop:** account for First-run setup in the packaged probe ([#617](https://github.com/alimek/t3-factory/issues/617)) ([d0f0faa](https://github.com/alimek/t3-factory/commit/d0f0faa6a588545ceba2e48c6c743446b6b7cd3c))
* **desktop:** open Studio below the title bar that holds the macOS window controls ([#609](https://github.com/alimek/t3-factory/issues/609)) ([83c08bb](https://github.com/alimek/t3-factory/commit/83c08bbb45844ea459824c52f59b79d36f069816))
* **flow-layout:** resolve the bundled ELK constructor without a type assertion ([#644](https://github.com/alimek/t3-factory/issues/644)) ([99812ff](https://github.com/alimek/t3-factory/commit/99812ffe71f706fe6ebdcbd9ee311b2f277686d4))
* **runner:** a queued turn cancelled before it started no longer fails a finished Block ([#514](https://github.com/alimek/t3-factory/issues/514)) ([#587](https://github.com/alimek/t3-factory/issues/587)) ([b7102a8](https://github.com/alimek/t3-factory/commit/b7102a8268e3dc75dc272a820802df326fa26832))
* **runner:** invoke the Block skill only on worker launch ([#593](https://github.com/alimek/t3-factory/issues/593)) ([8150328](https://github.com/alimek/t3-factory/commit/815032859edb996048b4d86f7140a52e7c7b826e))
* **runs:** keep a newly opened Run live when the previous one is released ([#504](https://github.com/alimek/t3-factory/issues/504)) ([7c3217e](https://github.com/alimek/t3-factory/commit/7c3217e16b4cf670d000897cd525307d0c4eb8d7))
* **runs:** wait for worker completion before offering Request report ([#610](https://github.com/alimek/t3-factory/issues/610)) ([9cb98e4](https://github.com/alimek/t3-factory/commit/9cb98e472bb39beb7002cf65e0d50373c6ca1bde))
* **studio:** ask before leaving an edited Flow for any Studio page ([#490](https://github.com/alimek/t3-factory/issues/490)) ([8f78426](https://github.com/alimek/t3-factory/commit/8f78426ae930f029b6157352fe8aff7c93d9ba39))
* **studio:** Escape steps back to the list; breadcrumbs clickable over the desktop title bar ([#611](https://github.com/alimek/t3-factory/issues/611)) ([d092d51](https://github.com/alimek/t3-factory/commit/d092d51487d0b81767746209ef1f9675db23fdfe))
* **studio:** offer only available Projects in owner menus ([#489](https://github.com/alimek/t3-factory/issues/489)) ([ce393d8](https://github.com/alimek/t3-factory/commit/ce393d88fd2fde6d67470f7beacffa2ff3e974c1))
* **studio:** return from a Trigger page through breadcrumbs and a back link ([#488](https://github.com/alimek/t3-factory/issues/488)) ([e702827](https://github.com/alimek/t3-factory/commit/e70282771e07b7678771353610cadddca6a7b1b7))
* **studio:** show model IDs when T3 omits display names ([#646](https://github.com/alimek/t3-factory/issues/646)) ([71a18ae](https://github.com/alimek/t3-factory/commit/71a18aefd4df944335ca35addc6c389f0caa488a))
* **ui:** type-scale sizes for palette, shortcut rows and key chips ([#536](https://github.com/alimek/t3-factory/issues/536)) ([#566](https://github.com/alimek/t3-factory/issues/566)) ([4a46454](https://github.com/alimek/t3-factory/commit/4a46454f74b09436666c7e30eb02d041941c08cd))
* validate E2E UI builds by input content ([#487](https://github.com/alimek/t3-factory/issues/487)) ([7ae1d45](https://github.com/alimek/t3-factory/commit/7ae1d45b48078b38d40b97bb05a43d531286b081))


### Performance Improvements

* **ci:** speed up quality gate, test suites, UI journeys and beta builds ([#642](https://github.com/alimek/t3-factory/issues/642)) ([3f8743b](https://github.com/alimek/t3-factory/commit/3f8743b2a14df74c0942e6ae941d989bc9eee0ad))
* **e2e:** reuse a current frontend build for journeys ([#594](https://github.com/alimek/t3-factory/issues/594)) ([e6a3137](https://github.com/alimek/t3-factory/commit/e6a313755dbbb1adab5c9e30457fcb0d323d6224))

## [0.8.0](https://github.com/alimek/t3-factory/compare/v0.7.1...v0.8.0) (2026-11-16)


### Features

* **chat-control:** keep Discord Run messages compact and post only when a human is needed ([#463](https://github.com/alimek/t3-factory/issues/463)) ([541b14d](https://github.com/alimek/t3-factory/commit/541b14d42b242ec71b18cf1eef1f4faad3a08a2f))


### Bug Fixes

* **chat-control:** accept forum posts when refreshing requester access ([#461](https://github.com/alimek/t3-factory/issues/461)) ([42a076d](https://github.com/alimek/t3-factory/commit/42a076dd92d54f6030dae9e0149479c7b70f1a78))
* **settings:** remove the Studio and opening hint footer from the Settings sidebar ([#473](https://github.com/alimek/t3-factory/issues/473)) ([e2557d5](https://github.com/alimek/t3-factory/commit/e2557d5361d658e735cd11a3dc4dabbdcf1fd4b8))

## [0.7.1](https://github.com/alimek/t3-factory/compare/v0.7.0...v0.7.1) (2026-11-16)


### Bug Fixes

* install Claude skills in a configured CLAUDE_CONFIG_DIR and correct stale docs ([#456](https://github.com/alimek/t3-factory/issues/456)) ([287c44c](https://github.com/alimek/t3-factory/commit/287c44c9246fd99cae659bc7d9735e61c174fa08))

## [0.7.0](https://github.com/alimek/t3-factory/compare/v0.6.0...v0.7.0) (2026-11-16)


### Features

* Condition with durable arrival-number routing ([#455](https://github.com/alimek/t3-factory/issues/455)) ([c689591](https://github.com/alimek/t3-factory/commit/c689591ed9335ae9b67429ef75372dd7475c2bd4))
* desktop notifications and Dock badge for required owner action ([#454](https://github.com/alimek/t3-factory/issues/454)) ([b58aa3a](https://github.com/alimek/t3-factory/commit/b58aa3a0333f2dc24d716741d40f91e340e194ab))


### Bug Fixes

* **frontend:** centre canvas ports on their wire anchors ([#438](https://github.com/alimek/t3-factory/issues/438)) ([ff601ab](https://github.com/alimek/t3-factory/commit/ff601ab21d446ac3b282d212178c758eb2f08b0c))
* Mod+Backspace in the Flow editor, chat control page template, one admission rule and shared helpers ([#427](https://github.com/alimek/t3-factory/issues/427)) ([49476f4](https://github.com/alimek/t3-factory/commit/49476f4c51bd33067d25a3712cff8959c2e22eb6))

## [0.6.0](https://github.com/alimek/t3-factory/compare/v0.5.0...v0.6.0) (2026-11-15)


### Features

* accept a stated reason in place of UI evidence screenshots ([#370](https://github.com/alimek/t3-factory/issues/370)) ([c4da5e3](https://github.com/alimek/t3-factory/commit/c4da5e33fd29f160557a67108435e687742c0c49))
* add an optional Revisit instruction to Agent blocks ([#353](https://github.com/alimek/t3-factory/issues/353)) ([afde9a4](https://github.com/alimek/t3-factory/commit/afde9a4d07519353a06defec865981368a605ef8))
* **backend:** remove Agents and Flows through Factory MCP ([#295](https://github.com/alimek/t3-factory/issues/295)) ([14afe00](https://github.com/alimek/t3-factory/commit/14afe00f89d3b1019e976f074f66ecb92cf932eb))
* control Factory Runs through an outbound-only Discord bot ([#324](https://github.com/alimek/t3-factory/issues/324)) ([c5327f0](https://github.com/alimek/t3-factory/commit/c5327f01d348ed520b7365643de526959442aef4))
* **frontend:** enable React Compiler with strict Hook diagnostics ([#367](https://github.com/alimek/t3-factory/issues/367)) ([2353e47](https://github.com/alimek/t3-factory/commit/2353e477edb836b9f19b333371112ed97b3c8feb))
* **frontend:** regroup Settings by scope with one page template ([#333](https://github.com/alimek/t3-factory/issues/333)) ([7511116](https://github.com/alimek/t3-factory/commit/751111691434d15598cdefa344312f125ac112e4))
* **frontend:** simplify the Run detail screen ([#303](https://github.com/alimek/t3-factory/issues/303)) ([521d507](https://github.com/alimek/t3-factory/commit/521d5079732223ad387a4f70c160383313b49b82))
* generate Run titles with a cheap T3 model ([#311](https://github.com/alimek/t3-factory/issues/311)) ([79d23bb](https://github.com/alimek/t3-factory/commit/79d23bbd146816656884ea9ad900f2369d3733e1))
* import and export Agents and Flows with optional model hints ([#371](https://github.com/alimek/t3-factory/issues/371)) ([27fd98a](https://github.com/alimek/t3-factory/commit/27fd98aaec0f229891b467521db80b979f146e36))
* **landing:** refresh the landing page to the Nov 2026 Figma design ([#425](https://github.com/alimek/t3-factory/issues/425)) ([ed512c1](https://github.com/alimek/t3-factory/commit/ed512c133136c6838ffebb8d51e21113cad7e00b))
* refresh open Studio views live when definitions change elsewhere ([#354](https://github.com/alimek/t3-factory/issues/354)) ([9b0ebee](https://github.com/alimek/t3-factory/commit/9b0ebee470cc1aec7b0b7b0fc23e3ea0c51fa53e))


### Bug Fixes

* **backend:** let T3 refresh the default worktree base ([#368](https://github.com/alimek/t3-factory/issues/368)) ([1510888](https://github.com/alimek/t3-factory/commit/151088881bd03b9051d0096d57d62332c6b1c59b))
* **backend:** settle a worker thread after its Continuation's response ([#352](https://github.com/alimek/t3-factory/issues/352)) ([0dddf5c](https://github.com/alimek/t3-factory/commit/0dddf5c7a79dd279177c863aa33a9e842cd8e252))
* follow T3 theme colors over the T3 connection without separate pairing ([#424](https://github.com/alimek/t3-factory/issues/424)) ([88cd49d](https://github.com/alimek/t3-factory/commit/88cd49d637e2a0cfbe5fc8696252bd493a2e5a46))
* **frontend:** pin sidebar Snoozed and Settled groups below open Runs ([#357](https://github.com/alimek/t3-factory/issues/357)) ([cc463d3](https://github.com/alimek/t3-factory/commit/cc463d3d1c26ffeadc74812d2f9dc9b88b52d9a1))
* reuse validation and preserve admitted image Starts ([#356](https://github.com/alimek/t3-factory/issues/356)) ([2c8275c](https://github.com/alimek/t3-factory/commit/2c8275c8b3a728d9b2e79198f38532d0c46d6e54))
* stop UI journey flakes from live resync, Settle focus and image test races ([#369](https://github.com/alimek/t3-factory/issues/369)) ([04828e3](https://github.com/alimek/t3-factory/commit/04828e39eb4a76bc8276c9735d11b26c6abc6abb))


### Performance Improvements

* read Agents without calling T3 and drop settingsStatus from HTTP ([#420](https://github.com/alimek/t3-factory/issues/420)) ([c29a9e7](https://github.com/alimek/t3-factory/commit/c29a9e7097f141f04f3afe1fdf0e3f582cc65311))

## [0.5.0](https://github.com/alimek/t3-factory/compare/v0.4.0...v0.5.0) (2026-11-13)


### Features

* Continuation blocks that prompt an earlier Agent's thread ([#234](https://github.com/alimek/t3-factory/issues/234)) ([48e2187](https://github.com/alimek/t3-factory/commit/48e21876d059c226933685dc22b3025ca20b63f2))
* **desktop:** General settings with a menu bar icon toggle, off by default ([#268](https://github.com/alimek/t3-factory/issues/268)) ([2899cd3](https://github.com/alimek/t3-factory/commit/2899cd38ba2d4748763429760a0377043052672c))
* follow T3 environment theme colors with Factory Light/Dark selection ([#267](https://github.com/alimek/t3-factory/issues/267)) ([bdc9ad9](https://github.com/alimek/t3-factory/commit/bdc9ad9e5637ad6d0226d1fd63f77888f027e748))
* **frontend:** make the Run composer one focal box that scales with the window ([#278](https://github.com/alimek/t3-factory/issues/278)) ([99a7f4a](https://github.com/alimek/t3-factory/commit/99a7f4abf53823e4ef66298db272cf85c2cf11df))
* generate and gate the development Run catalog from the seed list ([#237](https://github.com/alimek/t3-factory/issues/237)) ([3875286](https://github.com/alimek/t3-factory/commit/3875286511f13aa6868f58d77499efee230060f8))
* manage stored Run images in Settings ([#255](https://github.com/alimek/t3-factory/issues/255)) ([0ea59f9](https://github.com/alimek/t3-factory/commit/0ea59f9e5a04d470b205d12149ced211dbf5c8ae))
* Settle stops executing workers after confirmation and cancels a Run's automatic work ([#248](https://github.com/alimek/t3-factory/issues/248)) ([4fe3921](https://github.com/alimek/t3-factory/commit/4fe3921cb7c925a8b67ba6d8d37699e433ab6aac))
* start Factory Runs from a T3 Code conversation through MCP ([#260](https://github.com/alimek/t3-factory/issues/260)) ([a774464](https://github.com/alimek/t3-factory/commit/a77446426d2bb9a8585df5ce6817f6a5a4dd8fc7))
* Wait block with durable timers and Continue now ([#246](https://github.com/alimek/t3-factory/issues/246)) ([4bb7486](https://github.com/alimek/t3-factory/commit/4bb7486d61553f4d9d190b4a5722a67efcb1cbc9))
* workers mark the tracker issues they take as in progress ([#273](https://github.com/alimek/t3-factory/issues/273)) ([7eee9fc](https://github.com/alimek/t3-factory/commit/7eee9fcde792af004fd7f47ba7b31b40101547ae))


### Bug Fixes

* Agent reporting skips provider instances disabled in T3 ([#277](https://github.com/alimek/t3-factory/issues/277)) ([740e873](https://github.com/alimek/t3-factory/commit/740e87367c8a479c215f1859cb0ccf4faee16d88))
* **ci:** always report Quality gate after PR edits ([#249](https://github.com/alimek/t3-factory/issues/249)) ([2e8f4ab](https://github.com/alimek/t3-factory/commit/2e8f4abbfd561734a1897a0715d8695077615616))
* close gaps in manual Settle found after [#248](https://github.com/alimek/t3-factory/issues/248) ([#259](https://github.com/alimek/t3-factory/issues/259)) ([819456a](https://github.com/alimek/t3-factory/commit/819456a82a4cc1dab164c7e6943f9835a2c4cc13))
* **desktop:** check for updates every hour so a running app notices new builds ([#281](https://github.com/alimek/t3-factory/issues/281)) ([aaa5dc5](https://github.com/alimek/t3-factory/commit/aaa5dc59e1c2e74bfca6c3e99ee5421a6e95552a))

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
