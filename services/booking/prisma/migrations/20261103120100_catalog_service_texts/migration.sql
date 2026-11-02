-- Client-facing texts of the 35 services of the initial catalogue
-- (20261101120000_catalog_initial_services): a description and a list of
-- features per service and duration, provided by the owner (2026-11-02) and
-- edited for publication (docs/booking.md, "Каталог послуг"). Data migration
-- from prisma/templates/catalog-data-migration.sql.
--
-- Only "description", "features" and "updatedAt" of these 35 ids change:
-- names, durations, prices, sales and availability stay, no booking is
-- touched (bookings keep their own snapshot). Re-running sets the same texts.
-- If any of the ids is missing, the migration fails and changes nothing.
--
-- Explicit transaction: our migration task (`prisma migrate deploy`) would
-- otherwise run each statement in its own transaction and release the
-- calendar lock at once.
BEGIN;

-- The calendar lock of all booking writes
-- (src/modules/schedule/calendar-transaction.ts, CALENDAR_LOCK_KEY).
SELECT pg_advisory_xact_lock(7316442001);

DO $texts$
DECLARE
  updated integer;
BEGIN
  UPDATE "Service" AS s
  SET "description" = v.description, "features" = v.features, "updatedAt" = now()
  FROM (VALUES
    -- 1. Endosphères — demi-corps, une séance, 45 min
    ('57f78078-f65b-4723-b20b-aad89495c898'::uuid,
     'Une séance de massage mécanique Endosphères consacrée à une partie du corps. L’appareil associe compression et microvibrations pour un travail esthétique ciblé, dont les réglages et les zones sont définis avec la praticienne.',
     ARRAY[
       'Technique réalisée avec un appareil, différente d’un massage manuel.',
       'Format demi-corps : les zones traitées sont convenues avec la praticienne avant la séance.',
       'Une séance individuelle, sans engagement dans une cure ni résultat garanti.'
     ]::TEXT[]),
    -- 2. Madérothérapie, 60 min
    ('97b3295d-8d7e-4c7f-a8a8-bbe1df1af633'::uuid,
     'Un massage réalisé à l’aide d’accessoires en bois, utilisés pour effectuer des mouvements de roulement, de pression et de modelage. Cette séance propose un travail corporel rythmé, ajusté aux zones choisies et à votre sensibilité.',
     ARRAY[
       'Utilisation d’outils en bois de différentes formes.',
       'Sensations plus toniques qu’un massage de relaxation.',
       'Zones et intensité à convenir avec la praticienne.'
     ]::TEXT[]),
    -- 3. Madérothérapie, 90 min
    ('0eb52a15-863f-4981-8354-e1a4ab84c088'::uuid,
     'Une séance prolongée de madérothérapie pour consacrer davantage de temps aux zones sélectionnées. Les accessoires en bois permettent de varier les gestes, avec une progression adaptée à votre confort.',
     ARRAY[
       'Plus de temps pour répartir le travail entre plusieurs zones.',
       'Alternance de mouvements et de rythmes.',
       'Une durée plus longue n’implique pas une pression plus forte.'
     ]::TEXT[]),
    -- 4. Massage Tuina aux huiles chaudes, 60 min
    ('8768f0f0-3e76-4ed6-a273-5dd431a305e5'::uuid,
     'Un massage inspiré des techniques du Tuina, associant pressions, pétrissages et mouvements glissés grâce à l’utilisation d’une huile tiédie. Un format d’une heure pour une pause corporelle personnalisée.',
     ARRAY[
       'Travail manuel avec huile chaude.',
       'Pression ajustée selon les zones et les sensations.',
       'Signalez toute allergie ou sensibilité : la température et l’huile sont adaptées en conséquence.'
     ]::TEXT[]),
    -- 5. Massage Tuina aux huiles chaudes, 90 min
    ('039b509e-baff-4748-bb5e-094ed66a2198'::uuid,
     'Une version plus longue du massage Tuina aux huiles chaudes, qui laisse davantage de place à l’alternance entre gestes enveloppants et travail ciblé. Le rythme du soin s’adapte à vos préférences.',
     ARRAY[
       'Davantage de temps pour les zones prioritaires.',
       'Association de chaleur, de glissés et de pressions.',
       'Intensité modulable pendant la séance.'
     ]::TEXT[]),
    -- 6. Massage Tuina aux huiles chaudes, 120 min
    ('a0f4141c-2f1a-49b4-9ee6-09d15b0853af'::uuid,
     'Une séance de deux heures pour découvrir le Tuina aux huiles chaudes à un rythme plus posé. Ce format permet de répartir le massage entre différentes zones et de prolonger les séquences selon vos besoins.',
     ARRAY[
       'Format long avec une progression plus étendue.',
       'Temps disponible pour un travail global et ciblé.',
       'Possibilité d’ajuster la pression et le rythme au fil du soin.'
     ]::TEXT[]),
    -- 7. Massage Tuina traditionnel sans huile, 60 min
    ('69465693-b812-4dab-a100-f1f880b7c1b7'::uuid,
     'Un massage issu de la tradition chinoise, pratiqué sans huile et fondé sur des pressions, des pétrissages et des gestes rythmés. La séance privilégie le contact manuel et un travail adapté à votre ressenti.',
     ARRAY[
       'Sans huile ni longs mouvements glissés.',
       'Gestes pouvant être toniques.',
       'La tenue conseillée vous est indiquée lors de la prise de rendez-vous.'
     ]::TEXT[]),
    -- 8. Massage Tuina traditionnel sans huile, 90 min
    ('fe0523ef-4b29-4c4e-96fa-e8bdbd3f899e'::uuid,
     'Une séance prolongée de Tuina sans huile pour explorer plusieurs zones du corps et accorder davantage de temps aux endroits que vous souhaitez privilégier. Les gestes et leur intensité sont ajustés tout au long du massage.',
     ARRAY[
       'Travail manuel par pressions et pétrissages.',
       'Plus de temps pour personnaliser la répartition du soin.',
       'Pression adaptée, sans recherche systématique d’intensité.'
     ]::TEXT[]),
    -- 9. Massage Tuina traditionnel sans huile, 120 min
    ('81f49f12-7b74-43b2-9dc5-ad1e18c92b59'::uuid,
     'Un format de deux heures consacré au Tuina traditionnel sans huile. La durée permet une approche progressive, avec une attention particulière au rythme du massage et à vos sensations.',
     ARRAY[
       'Séance longue, organisée autour de vos priorités.',
       'Technique sans huile.',
       'Temps supplémentaire pour les transitions et le travail ciblé.'
     ]::TEXT[]),
    -- 10. Massage ayurvédique, 60 min
    ('cf4fb0b1-7b35-455b-8367-e4b422639610'::uuid,
     'Un massage inspiré de la tradition ayurvédique indienne, pensé comme un moment de détente corporelle. Son déroulement, son rythme et les produits éventuellement utilisés dépendent du protocole proposé par la praticienne.',
     ARRAY[
       'Inspiration ayurvédique.',
       'Approche rythmée et enveloppante selon le protocole.',
       'L’huile utilisée et les zones massées sont précisées avec la praticienne.'
     ]::TEXT[]),
    -- 11. Massage ayurvédique, 90 min
    ('40c8f682-6222-4cd0-b6aa-d3bcfb2a80d3'::uuid,
     'Une séance prolongée de massage d’inspiration ayurvédique pour profiter d’un rythme plus ample et d’un temps de détente plus long. Le soin est organisé selon le protocole pratiqué et vos préférences.',
     ARRAY[
       'Davantage de temps pour dérouler le massage.',
       'Rythme et pression personnalisables.'
     ]::TEXT[]),
    -- 12. Massage de drainage lymphatique, 60 min
    ('ca2c3570-e81f-4410-b447-7fc90618da8f'::uuid,
     'Un massage aux gestes légers et rythmés, avec une attention portée au travail superficiel de la peau. Cette séance privilégie une approche douce, différente des massages musculaires profonds.',
     ARRAY[
       'Pressions légères et mouvements répétitifs.',
       'Absence de pétrissage musculaire intense.',
       'En cas de lymphœdème ou de problème de santé, demandez l’avis de votre médecin avant la séance.'
     ]::TEXT[]),
    -- 13. Massage de drainage lymphatique, 90 min
    ('713d9d2a-c90e-42e3-a224-99390862f856'::uuid,
     'Une séance de drainage lymphatique prolongée pour consacrer davantage de temps aux zones prévues dans le protocole. Les mouvements restent légers et réguliers, sans rechercher une pression profonde.',
     ARRAY[
       'Format plus long avec une gestuelle douce.',
       'Temps supplémentaire pour suivre le protocole.',
       'Ce soin ne vise ni la perte de poids ni une « détox ».'
     ]::TEXT[]),
    -- 14. Massage de drainage lymphatique, 120 min
    ('c513a89e-712f-4462-83d0-3b1a08df1f92'::uuid,
     'Un format de deux heures permettant de dérouler le protocole de drainage à un rythme posé. La répartition du soin est définie avec la praticienne selon les zones concernées et l’adéquation de la prestation à votre situation.',
     ARRAY[
       'Durée étendue, sans augmentation nécessaire de la pression.',
       'Gestes superficiels et rythmés.',
       'Ne remplace pas un suivi médical lorsqu’un gonflement nécessite une évaluation.'
     ]::TEXT[]),
    -- 15. Massage de la tête aux pieds, 60 min
    ('2703c0d8-c30a-49d7-bd41-bc51179dd22f'::uuid,
     'Un massage global pour s’accorder une pause et porter attention à l’ensemble du corps. La séance répartit le temps entre différentes régions, de la tête jusqu’aux pieds, selon le déroulement convenu.',
     ARRAY[
       'Approche globale plutôt que centrée sur une seule zone.',
       'Répartition du temps adaptée à vos préférences.',
       'Zones incluses et zones que vous souhaitez éviter convenues avant le soin.'
     ]::TEXT[]),
    -- 16. Massage de la tête aux pieds, 90 min
    ('c438d102-95ae-4c7d-9dda-87cf966d3efd'::uuid,
     'Une séance globale plus longue pour prendre le temps de passer d’une région du corps à l’autre. Ce format permet de conserver une approche d’ensemble tout en accordant davantage d’attention à certaines zones.',
     ARRAY[
       'Plus de temps pour les transitions et les séquences de massage.',
       'Possibilité de privilégier une région sans limiter toute la séance à celle-ci.',
       'Rythme et pression ajustables.'
     ]::TEXT[]),
    -- 17. Massage de la tête aux pieds, 120 min
    ('b84f23ba-773d-4ff2-b128-10a1ee22a4cf'::uuid,
     'Deux heures consacrées à un massage global, pour une expérience plus longue et progressive. La séance laisse de la place à vos priorités, tout en conservant un parcours corporel d’ensemble.',
     ARRAY[
       'Format long pour une pause prolongée.',
       'Répartition personnalisée entre les différentes zones.',
       'Intensité définie selon votre confort, indépendamment de la durée.'
     ]::TEXT[]),
    -- 18. Massage de la tête, du cou et des trapèzes, 30 min
    ('353c5f3d-62d3-43e1-a9f4-65181e356e6b'::uuid,
     'Un massage ciblé sur la tête, la nuque et le haut des épaules. Une courte pause pour porter attention à ces zones souvent sollicitées dans les activités quotidiennes.',
     ARRAY[
       'Séance localisée sur le haut du corps.',
       'Pression adaptée aux zones sensibles.',
       'Massage du cuir chevelu et utilisation d’huile convenus avant la séance.'
     ]::TEXT[]),
    -- 19. Massage de tout le dos, 30 min
    ('696afe81-79e4-4114-961c-af875229a2b1'::uuid,
     'Une demi-heure consacrée au dos, du haut des épaules à la région lombaire. Le massage est organisé selon vos préférences, avec davantage de temps sur les zones que vous souhaitez privilégier.',
     ARRAY[
       'Format ciblé, sans massage complet du corps.',
       'Alternance de gestes larges et de travail localisé selon la pratique.',
       'Intensité adaptée à votre ressenti.'
     ]::TEXT[]),
    -- 20. Massage des tissus profonds, 55 min
    ('a587db53-7b29-4b32-adc3-15d68289cfa8'::uuid,
     'Un massage au rythme lent, utilisant des pressions progressives pour un travail musculaire ciblé. La séance se concentre sur les zones choisies, dans une recherche de confort plutôt que de pression maximale.',
     ARRAY[
       'Gestes lents et travail localisé.',
       'Pression plus soutenue qu’un massage léger, selon votre tolérance.',
       'La douleur n’est pas un objectif du soin.'
     ]::TEXT[]),
    -- 21. Massage des tissus profonds, 85 min
    ('018a645a-7ff7-48fd-a730-894ef3b62aa5'::uuid,
     'Une séance prolongée de massage des tissus profonds pour répartir le travail entre plusieurs régions ou accorder plus de temps à une zone prioritaire. Les pressions sont introduites progressivement.',
     ARRAY[
       'Temps supplémentaire pour un travail ciblé et progressif.',
       'Intensité ajustée pendant toute la séance.',
       'Possibilité de diminuer la pression ou d’interrompre un geste à tout moment.'
     ]::TEXT[]),
    -- 22. Massage enfant — à partir de 6 ans, 30 min
    ('570a1b88-f7e4-43e7-9e25-23455764aa74'::uuid,
     'Un temps de massage adapté à l’âge, à la sensibilité et au rythme de l’enfant. La séance privilégie des gestes doux et une communication simple, en respectant son envie de poursuivre ou de s’arrêter.',
     ARRAY[
       'À partir de 6 ans.',
       'Accord du représentant légal et assentiment de l’enfant.',
       'Présence d’un adulte accompagnant et déroulement convenus avant le rendez-vous.'
     ]::TEXT[]),
    -- 23. Massage myofascial, 55 min
    ('e8714bef-1897-4dd9-9ee9-c0c31d58f293'::uuid,
     'Une approche manuelle lente, avec des pressions maintenues et des mouvements progressifs sur les tissus. La séance se concentre sur les régions choisies et sur les sensations rencontrées pendant le travail.',
     ARRAY[
       'Rythme lent, différent d’un massage fluide et continu.',
       'Pressions maintenues plutôt qu’une succession rapide de gestes.',
       'Ne suppose pas nécessairement une pression forte.'
     ]::TEXT[]),
    -- 24. Massage myofascial, 85 min
    ('f85a106b-7f20-4ef1-88f7-670cacee7747'::uuid,
     'Un format prolongé de massage myofascial pour laisser davantage de temps au travail manuel et aux transitions entre les zones. La progression est guidée par votre confort et les priorités convenues.',
     ARRAY[
       'Temps plus long pour les séquences de travail lent.',
       'Possibilité d’aborder plusieurs régions.',
       'Pression et durée des gestes adaptées au ressenti.'
     ]::TEXT[]),
    -- 25. Massage pierres chaudes, 60 min
    ('3d21cb0f-5905-4b76-af1c-a0268602ad88'::uuid,
     'Un massage associant le contact des mains à la chaleur de pierres lisses. La chaleur apporte une dimension enveloppante à la séance, avec une température adaptée à votre sensibilité.',
     ARRAY[
       'Utilisation de pierres chauffées.',
       'Température vérifiée et ajustée pendant le soin.',
       'Pose des pierres et utilisation en mouvement selon le protocole pratiqué.'
     ]::TEXT[]),
    -- 26. Massage pierres chaudes, 90 min
    ('7cbaae05-e433-4087-b64e-fed91195ad2e'::uuid,
     'Une séance prolongée pour profiter de l’alternance entre massage manuel et chaleur des pierres. Le temps supplémentaire permet un déroulement plus ample et une attention accrue aux zones choisies.',
     ARRAY[
       'Association du toucher et de la chaleur.',
       'Format plus long pour un rythme posé.',
       'Possibilité de réduire la chaleur ou de poursuivre sans pierres selon votre confort.'
     ]::TEXT[]),
    -- 27. Massage pierres chaudes, 120 min
    ('1abe839a-35e1-4322-aec3-c03b3fcd6864'::uuid,
     'Deux heures consacrées à un massage aux pierres chaudes, pour une pause prolongée. La séance alterne les séquences selon le protocole, avec une surveillance régulière de votre confort thermique.',
     ARRAY[
       'Durée étendue avec une progression personnalisée.',
       'Chaleur ajustée tout au long de la séance.',
       'Une durée plus longue ne signifie pas une exposition continue aux pierres.'
     ]::TEXT[]),
    -- 28. Massage postnatal, 60 min
    ('3dd3ebdd-da7b-4ca2-9f13-3a46d96be6f4'::uuid,
     'Une parenthèse de bien-être après la naissance, adaptée à votre confort et à votre récupération du moment. Les positions, les zones massées et la pression sont convenues avant la séance.',
     ARRAY[
       'Installation adaptée à la période postnatale.',
       'Prise en compte des zones sensibles et des préférences personnelles.',
       'Le moment de la première séance dépend des suites de l’accouchement et de l’avis de votre soignant.'
     ]::TEXT[]),
    -- 29. Massage postnatal, 90 min
    ('2bdfa0e1-5556-46a7-869a-ef48114dc07c'::uuid,
     'Une séance postnatale plus longue pour prendre le temps de s’installer et de recevoir un massage à un rythme confortable. Le déroulement reste flexible, selon votre fatigue et vos besoins du jour.',
     ARRAY[
       'Davantage de temps pour l’installation et le massage.',
       'Possibilité d’adapter les positions et de prévoir des pauses.',
       'Venue avec bébé : renseignez-vous auprès du cabinet avant la réservation.'
     ]::TEXT[]),
    -- 30. Massage premium pour femmes, 60 min
    ('0a879540-15e2-4e5a-8b8a-ab3ce30cc25e'::uuid,
     'Une séance de massage destinée aux femmes, pensée comme un moment de bien-être personnalisé. Le contenu du soin est défini avec la praticienne selon vos attentes.',
     ARRAY[
       'Prestation réservée aux femmes.',
       'Zones et pression à convenir avant le massage.'
     ]::TEXT[]),
    -- 31. Massage prénatal — future maman, 60 min
    ('9b081644-29e6-496a-9303-6e07a12966d4'::uuid,
     'Un massage de bien-être adapté à la grossesse, avec une installation choisie pour votre confort. Le déroulement tient compte du stade de la grossesse, de votre sensibilité et des éventuelles recommandations de votre suivi médical.',
     ARRAY[
       'Positions adaptées, sans pression sur l’abdomen.',
       'Gestes et intensité spécifiques à la situation.',
       'Stade de grossesse accepté à vérifier auprès du cabinet avant la réservation.'
     ]::TEXT[]),
    -- 32. Massage sportif, 55 min
    ('11a5f7a9-4e3a-4fe1-bfcb-ad85073b7ec4'::uuid,
     'Un massage orienté vers les zones sollicitées par votre activité physique. La séance est adaptée à votre pratique, au moment choisi par rapport à l’effort et aux sensations que vous souhaitez prendre en compte.',
     ARRAY[
       'Travail ciblé selon l’activité pratiquée.',
       'Pression et rythme ajustés au contexte.',
       'Ne remplace pas l’évaluation ou la rééducation d’une blessure.'
     ]::TEXT[]),
    -- 33. Massage sportif, 90 min
    ('dea5ef63-6ab1-4338-aa05-2fab089ee070'::uuid,
     'Une séance prolongée pour travailler plusieurs groupes musculaires ou accorder davantage de temps aux zones prioritaires. Le contenu est défini selon votre activité et votre état de fatigue du jour.',
     ARRAY[
       'Temps disponible pour plusieurs régions du corps.',
       'Approche ciblée plutôt qu’une pression forte systématique.',
       'Séance à adapter si une douleur inhabituelle ou une blessure est présente.'
     ]::TEXT[]),
    -- 34. Massage sportif, 120 min
    ('e416e435-88a8-458c-8737-3f9b5b9b5e6f'::uuid,
     'Un format de deux heures pour un massage sportif plus étendu, combinant une attention globale et des séquences ciblées. La séance progresse selon vos priorités, sans chercher à multiplier les gestes intenses.',
     ARRAY[
       'Répartition du travail entre plusieurs groupes musculaires.',
       'Ajustement de l’intensité au fil de la séance.',
       'Aucun engagement de performance ou de récupération accélérée.'
     ]::TEXT[]),
    -- 35. Réflexologie plantaire, 30 min
    ('e0a4be32-524f-49e3-b525-1051092007d3'::uuid,
     'Une séance centrée sur les pieds, avec des pressions sur différentes zones de la plante et des mouvements de massage. Un format court pour apprécier un travail localisé et s’accorder un moment de détente.',
     ARRAY[
       'Travail principalement réalisé sur les pieds.',
       'Pressions adaptées à leur sensibilité.',
       'Ne constitue ni un diagnostic ni un traitement médical.'
     ]::TEXT[])
  ) AS v (id, description, features)
  WHERE s."id" = v.id;

  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated <> 35 THEN
    RAISE EXCEPTION 'catalog texts: expected 35 services, updated %', updated;
  END IF;
END
$texts$;

COMMIT;
