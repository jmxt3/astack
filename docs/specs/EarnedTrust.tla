---------------------------- MODULE EarnedTrust ----------------------------
EXTENDS Naturals

CONSTANT MaxStageHops

VARIABLES
  cat,
  mode,
  ceiling,
  earned,
  confirmed,
  level,
  autoPromoted,
  hasUndo,
  undoFrom,
  chainValid,
  demotionOk,
  stage,
  stageHops

vars ==
  <<cat, mode, ceiling, earned, confirmed, level, autoPromoted,
    hasUndo, undoFrom, chainValid, demotionOk, stage, stageHops>>

Min(a, b) == IF a <= b THEN a ELSE b

CatCap(c, ceil) == IF c = "governance" THEN Min(2, ceil) ELSE ceil

EffectiveLevel(c, m, ceil, earn, conf, valid) ==
  IF ~valid THEN 0
  ELSE LET cap == CatCap(c, ceil)
           cappedEarned == Min(earn, cap)
       IN IF m = "auto" /\ c /= "governance"
          THEN cappedEarned
          ELSE Min(cappedEarned, conf)

RequiredLevelForStage(s) ==
  IF s = 1 THEN 1
  ELSE IF s = 2 THEN 2
  ELSE 3

TypeOK ==
  /\ cat \in {"ui", "governance"}
  /\ mode \in {"manual", "auto"}
  /\ ceiling \in 1..3
  /\ earned \in 0..3
  /\ confirmed \in 0..3
  /\ level \in 0..3
  /\ autoPromoted \in BOOLEAN
  /\ hasUndo \in BOOLEAN
  /\ undoFrom \in 0..3
  /\ chainValid \in BOOLEAN
  /\ demotionOk \in BOOLEAN
  /\ stage \in 1..4
  /\ stageHops \in 0..MaxStageHops

Init ==
  /\ cat \in {"ui", "governance"}
  /\ mode = "manual"
  /\ ceiling = 2
  /\ earned = 0
  /\ confirmed = 0
  /\ level = 0
  /\ autoPromoted = FALSE
  /\ hasUndo = FALSE
  /\ undoFrom = 0
  /\ chainValid = TRUE
  /\ demotionOk = TRUE
  /\ stage = 1
  /\ stageHops = 0

CleanOutcome ==
  /\ chainValid
  /\ LET maxCat == IF cat = "governance" THEN 2 ELSE 3
         nextEarned == Min(maxCat, earned + 1)
         nextLevel == EffectiveLevel(cat, mode, ceiling, nextEarned, confirmed, TRUE)
         didAuto == mode = "auto" /\ cat /= "governance" /\ nextLevel > level
     IN /\ earned' = nextEarned
        /\ confirmed' = IF didAuto THEN nextLevel ELSE confirmed
        /\ level' = nextLevel
        /\ autoPromoted' = (autoPromoted \/ didAuto)
        /\ hasUndo' = IF didAuto THEN TRUE ELSE hasUndo
        /\ undoFrom' = IF didAuto THEN level ELSE undoFrom
        /\ UNCHANGED <<cat, mode, ceiling, chainValid, demotionOk, stage, stageHops>>

BadOutcome ==
  /\ chainValid
  /\ LET cap == CatCap(cat, ceiling)
         capped == Min(earned, cap)
         nextEarned == IF capped > 0 THEN capped - 1 ELSE 0
         nextConf == IF level > 0 THEN Min(nextEarned, level - 1) ELSE 0
         nextLevel == EffectiveLevel(cat, mode, ceiling, nextEarned, nextConf, TRUE)
     IN /\ earned' = nextEarned
        /\ confirmed' = nextConf
        /\ level' = nextLevel
        /\ hasUndo' = FALSE
        /\ undoFrom' = 0
        /\ demotionOk' = (demotionOk /\ (level > 0 => nextLevel < level))
        /\ UNCHANGED <<cat, mode, ceiling, autoPromoted, chainValid, stage, stageHops>>

ManualPromote ==
  /\ chainValid
  /\ LET cap == CatCap(cat, ceiling)
         cappedEarned == Min(earned, cap)
     IN /\ level < cappedEarned
        /\ LET nextConf == level + 1
               nextLevel == EffectiveLevel(cat, mode, ceiling, earned, nextConf, TRUE)
           IN /\ confirmed' = nextConf
              /\ level' = nextLevel
              /\ hasUndo' = FALSE
              /\ undoFrom' = 0
              /\ UNCHANGED <<cat, mode, ceiling, earned, autoPromoted, chainValid, demotionOk, stage, stageHops>>

TogglePromotionMode ==
  /\ chainValid
  /\ LET nextMode == IF mode = "manual" THEN "auto" ELSE "manual"
         nextLevel == EffectiveLevel(cat, nextMode, ceiling, earned, confirmed, TRUE)
         didAuto == nextMode = "auto" /\ cat /= "governance" /\ nextLevel > level
     IN /\ mode' = nextMode
        /\ confirmed' = IF didAuto THEN nextLevel ELSE confirmed
        /\ level' = nextLevel
        /\ autoPromoted' = (autoPromoted \/ didAuto)
        /\ hasUndo' = IF didAuto THEN TRUE ELSE hasUndo
        /\ undoFrom' = IF didAuto THEN level ELSE undoFrom
        /\ UNCHANGED <<cat, ceiling, earned, chainValid, demotionOk, stage, stageHops>>

UndoAutoPromo ==
  /\ chainValid
  /\ hasUndo
  /\ LET cap == CatCap(cat, ceiling)
         nextConf == Min(undoFrom, cap)
         nextLevel == EffectiveLevel(cat, "manual", ceiling, earned, nextConf, TRUE)
     IN /\ mode' = "manual"
        /\ confirmed' = nextConf
        /\ level' = nextLevel
        /\ hasUndo' = FALSE
        /\ undoFrom' = 0
        /\ UNCHANGED <<cat, ceiling, earned, autoPromoted, chainValid, demotionOk, stage, stageHops>>

SetCeiling(c) ==
  /\ chainValid
  /\ LET clamped == CatCap(cat, c)
         baseConf == Min(confirmed, clamped)
         nextLevel == EffectiveLevel(cat, mode, clamped, earned, baseConf, TRUE)
         didAuto == mode = "auto" /\ cat /= "governance" /\ nextLevel > level
         clampedDown == clamped < level
     IN /\ ceiling' = clamped
        /\ confirmed' = IF didAuto THEN nextLevel ELSE baseConf
        /\ level' = nextLevel
        /\ autoPromoted' = (autoPromoted \/ didAuto)
        /\ hasUndo' = IF didAuto THEN TRUE ELSE IF clampedDown THEN FALSE ELSE hasUndo
        /\ undoFrom' = IF didAuto THEN level ELSE IF clampedDown THEN 0 ELSE undoFrom
        /\ UNCHANGED <<cat, mode, earned, chainValid, demotionOk, stage, stageHops>>

CorruptLedger ==
  /\ chainValid
  /\ chainValid' = FALSE
  /\ level' = 0
  /\ hasUndo' = FALSE
  /\ undoFrom' = 0
  /\ UNCHANGED <<cat, mode, ceiling, earned, confirmed, autoPromoted, demotionOk, stage, stageHops>>

AdvanceStage ==
  /\ chainValid
  /\ stage < 4
  /\ stageHops < MaxStageHops
  /\ level >= RequiredLevelForStage(stage)
  /\ stage' = stage + 1
  /\ stageHops' = stageHops + 1
  /\ UNCHANGED <<cat, mode, ceiling, earned, confirmed, level, autoPromoted, hasUndo, undoFrom, chainValid, demotionOk>>

Stutter ==
  /\ (~chainValid \/ stage = 4 \/ stageHops = MaxStageHops)
  /\ UNCHANGED vars

Next ==
  \/ CleanOutcome
  \/ BadOutcome
  \/ ManualPromote
  \/ TogglePromotionMode
  \/ UndoAutoPromo
  \/ \E c \in {1, 2, 3} : SetCeiling(c)
  \/ CorruptLedger
  \/ AdvanceStage
  \/ Stutter

Spec == Init /\ [][Next]_vars

LevelRespectsCeiling == level <= ceiling

GovernanceNeverExceedsL2 ==
  cat = "governance" => (level <= 2 /\ ceiling <= 2 /\ earned <= 2)

GovernanceNeverAutoPromotes ==
  cat = "governance" => ~autoPromoted

GovernanceNeverAutoMerges ==
  cat = "governance" => stage < 4

ManualNeverExceedsConfirmed ==
  (chainValid /\ (mode = "manual" \/ cat = "governance")) => (level <= confirmed)

FrozenForcesL0 ==
  ~chainValid => level = 0

BadOutcomeDemotes ==
  demotionOk = TRUE

StageHandoffsBounded ==
  stageHops <= MaxStageHops /\ stage \in 1..4
=============================================================================
