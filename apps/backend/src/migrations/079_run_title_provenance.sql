-- Each Run records how its title was chosen. Runs started before provenance existed cannot say
-- whether their title was the prompt's first line or the owner's choice, so they become legacy
-- with their titles unchanged; Start always records the provenance it was given.
ALTER TABLE runs ADD COLUMN title_provenance TEXT NOT NULL DEFAULT 'legacy'
  CHECK (title_provenance IN ('automatic', 'manual', 'generated', 'legacy'))
