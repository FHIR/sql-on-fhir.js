/**
 * ConceptMap fixtures shared by the terminology tests.
 *
 * Author: John Grimes
 */

export const SCT = 'http://snomed.info/sct'
export const ICD10 = 'http://hl7.org/fhir/sid/icd-10'

/**
 * The SNOMED CT to ICD-10 map from the worked example on the "Terminology in
 * SQL" page: two mapped codes and one `noMap` element, with the ICD-10 version
 * carried as a `|version` suffix on `group.target`.
 *
 * @returns {object} a fresh copy of the ConceptMap, safe to mutate.
 */
export function sctToIcd10Map() {
  return {
    resourceType: 'ConceptMap',
    url: 'http://example.org/ConceptMap/sct-to-icd10',
    version: '2026',
    name: 'SnomedCtToIcd10',
    status: 'active',
    group: [
      {
        source: SCT,
        target: `${ICD10}|2019`,
        element: [
          {
            code: '22298006',
            display: 'Myocardial infarction',
            target: [{ code: 'I21', display: 'Acute myocardial infarction', relationship: 'equivalent' }],
          },
          {
            code: '73211009',
            display: 'Diabetes mellitus',
            target: [
              {
                code: 'E14',
                display: 'Unspecified diabetes mellitus',
                relationship: 'source-is-broader-than-target',
                comment: 'The source covers every type of diabetes',
              },
            ],
          },
          {
            code: '102499006',
            display: 'Fit and well',
            noMap: true,
            comment: 'A finding of health has no counterpart in a classification of disease',
          },
        ],
      },
    ],
  }
}

/**
 * The relation rows the specification's worked example derives from
 * `sctToIcd10Map()`, in document order.
 */
export const SCT_TO_ICD10_ROWS = [
  {
    source_system: SCT,
    source_version: null,
    source_code: '22298006',
    source_display: 'Myocardial infarction',
    target_system: ICD10,
    target_version: '2019',
    target_code: 'I21',
    target_display: 'Acute myocardial infarction',
    relationship: 'equivalent',
  },
  {
    source_system: SCT,
    source_version: null,
    source_code: '73211009',
    source_display: 'Diabetes mellitus',
    target_system: ICD10,
    target_version: '2019',
    target_code: 'E14',
    target_display: 'Unspecified diabetes mellitus',
    relationship: 'source-is-broader-than-target',
  },
  {
    source_system: SCT,
    source_version: null,
    source_code: '102499006',
    source_display: 'Fit and well',
    target_system: ICD10,
    target_version: '2019',
    target_code: null,
    target_display: null,
    relationship: null,
  },
]
