/**
 * Unit tests for Patient compartment membership.
 *
 * Author: John Grimes
 */

import { patientCompartmentReferences, inPatientCompartment } from '../../src/server/compartment.js'

const patients = new Set(['Patient/p1'])

describe('patientCompartmentReferences', () => {
  test('a Patient is a member of its own compartment', () => {
    expect(patientCompartmentReferences({ resourceType: 'Patient', id: 'p1' })).toEqual(['Patient/p1'])
  })

  test('collects references from a repeating element', () => {
    const observation = {
      resourceType: 'Observation',
      subject: { reference: 'Patient/p1' },
      performer: [{ reference: 'Practitioner/x' }, { reference: 'Patient/p2' }],
    }
    expect(patientCompartmentReferences(observation).sort()).toEqual([
      'Patient/p1',
      'Patient/p2',
      'Practitioner/x',
    ])
  })

  test('returns nothing for a type outside the compartment', () => {
    expect(patientCompartmentReferences({ resourceType: 'Organization', id: 'o1' })).toEqual([])
  })
})

describe('inPatientCompartment', () => {
  test('Observation via subject', () => {
    expect(
      inPatientCompartment({ resourceType: 'Observation', subject: { reference: 'Patient/p1' } }, patients),
    ).toBe(true)
  })

  test('Observation via performer array', () => {
    const observation = {
      resourceType: 'Observation',
      subject: { reference: 'Patient/other' },
      performer: [{ reference: 'Practitioner/x' }, { reference: 'Patient/p1' }],
    }
    expect(inPatientCompartment(observation, patients)).toBe(true)
  })

  test('Immunization via patient', () => {
    expect(
      inPatientCompartment({ resourceType: 'Immunization', patient: { reference: 'Patient/p1' } }, patients),
    ).toBe(true)
  })

  test('excludes a resource referencing a different patient', () => {
    expect(
      inPatientCompartment({ resourceType: 'Encounter', subject: { reference: 'Patient/p2' } }, patients),
    ).toBe(false)
  })

  test('Organization is never in the compartment', () => {
    expect(inPatientCompartment({ resourceType: 'Organization', id: 'p1' }, patients)).toBe(false)
  })

  test('matches an absolute reference on its trailing Type/id segment', () => {
    const condition = {
      resourceType: 'Condition',
      subject: { reference: 'http://example.org/fhir/Patient/p1' },
    }
    expect(inPatientCompartment(condition, patients)).toBe(true)
  })

  test('fans out through Group.member.entity', () => {
    const group = {
      resourceType: 'Group',
      member: [{ entity: { reference: 'Patient/p9' } }, { entity: { reference: 'Patient/p1' } }],
    }
    expect(inPatientCompartment(group, patients)).toBe(true)
    expect(inPatientCompartment({ ...group, member: [group.member[0]] }, patients)).toBe(false)
  })
})
