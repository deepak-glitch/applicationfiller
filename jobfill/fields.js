/*
 * Shared field schema for JobFill.
 *
 * Loaded by BOTH the popup (to build the profile editor) and the content
 * script (to drive the fill engine). Everything the extension knows how to
 * fill lives here — edit it to tune matching.
 *
 * Each field:
 *   key      unique id, used as the storage key for the saved value
 *   label    human label shown in the popup editor
 *   type     'text' | 'email' | 'tel' | 'url' | 'textarea' | 'choice'
 *   keywords words/phrases we look for in a form field's label/name/id/etc.
 *            (order doesn't matter; more specific phrases win automatically)
 *   choices  for type 'choice' only — the options offered in the popup and the
 *            text we try to match against radio buttons / dropdown options
 */
var FIELD_GROUPS = [
  {
    group: 'Personal',
    fields: [
      { key: 'firstName', label: 'First name', type: 'text',
        keywords: ['first name', 'given name', 'firstname', 'fname', 'first'] },
      { key: 'lastName', label: 'Last name', type: 'text',
        keywords: ['last name', 'family name', 'surname', 'lastname', 'lname', 'last'] },
      { key: 'fullName', label: 'Full name', type: 'text',
        keywords: ['full name', 'legal name', 'candidate name', 'your name', 'name'] },
      { key: 'preferredName', label: 'Preferred name', type: 'text',
        keywords: ['preferred name', 'nickname', 'goes by'] },
      { key: 'email', label: 'Email', type: 'email',
        keywords: ['email address', 'e mail', 'email'] },
      { key: 'phone', label: 'Phone', type: 'tel',
        keywords: ['phone number', 'mobile number', 'contact number', 'telephone', 'mobile', 'phone', 'cell'] },
    ],
  },
  {
    group: 'Address',
    fields: [
      { key: 'address', label: 'Street address', type: 'text',
        keywords: ['street address', 'address line 1', 'addressline1', 'mailing address', 'address', 'street'] },
      { key: 'addressLine2', label: 'Address line 2', type: 'text',
        keywords: ['address line 2', 'addressline2', 'apartment', 'apt', 'suite', 'unit'] },
      { key: 'city', label: 'City', type: 'text',
        keywords: ['city', 'town', 'municipality'] },
      { key: 'state', label: 'State / Province', type: 'text',
        keywords: ['state province', 'state', 'province', 'region'] },
      { key: 'zip', label: 'ZIP / Postal code', type: 'text',
        keywords: ['postal code', 'zip code', 'postcode', 'zip', 'postal'] },
      { key: 'country', label: 'Country', type: 'text',
        keywords: ['country', 'nation'] },
    ],
  },
  {
    group: 'Links',
    fields: [
      { key: 'linkedin', label: 'LinkedIn URL', type: 'url',
        keywords: ['linkedin profile', 'linkedin url', 'linkedin', 'linked in'] },
      { key: 'github', label: 'GitHub URL', type: 'url',
        keywords: ['github url', 'github profile', 'github', 'git hub'] },
      { key: 'portfolio', label: 'Portfolio / Website', type: 'url',
        keywords: ['portfolio', 'personal website', 'personal site', 'website', 'web site', 'homepage', 'url'] },
      { key: 'twitter', label: 'Twitter / X', type: 'url',
        keywords: ['twitter', 'x profile', 'x url'] },
    ],
  },
  {
    group: 'Professional',
    fields: [
      { key: 'currentCompany', label: 'Current company', type: 'text',
        keywords: ['current company', 'current employer', 'employer', 'company'] },
      { key: 'currentTitle', label: 'Current title', type: 'text',
        keywords: ['current title', 'current role', 'job title', 'position title', 'title', 'position'] },
      { key: 'salary', label: 'Salary expectation', type: 'text',
        keywords: ['salary expectation', 'expected salary', 'desired salary', 'expected compensation', 'salary', 'compensation'] },
      { key: 'startDate', label: 'Available start date', type: 'text',
        keywords: ['available start date', 'earliest start date', 'start date', 'availability', 'notice period'] },
      { key: 'howHeard', label: 'How did you hear about us?', type: 'text',
        keywords: ['how did you hear', 'hear about us', 'referral source', 'source', 'referral'] },
    ],
  },
  {
    group: 'Work authorization',
    fields: [
      { key: 'workAuthorized', label: 'Authorized to work?', type: 'choice',
        choices: ['Yes', 'No'],
        keywords: ['legally authorized to work', 'authorized to work', 'authorised to work', 'work authorization',
                   'eligible to work', 'right to work', 'legally authorized'] },
      { key: 'requireSponsorship', label: 'Require visa sponsorship?', type: 'choice',
        choices: ['Yes', 'No'],
        keywords: ['require sponsorship', 'need sponsorship', 'visa sponsorship', 'immigration sponsorship',
                   'require visa', 'sponsorship'] },
    ],
  },
  {
    group: 'Self-identification (optional — leave blank to skip)',
    fields: [
      { key: 'gender', label: 'Gender', type: 'choice',
        choices: ['Male', 'Female', 'Non-binary', 'Decline to self-identify'],
        keywords: ['gender identity', 'gender', 'sex'] },
      { key: 'hispanic', label: 'Hispanic / Latino?', type: 'choice',
        choices: ['Yes', 'No', 'Decline to self-identify'],
        keywords: ['hispanic or latino', 'hispanic', 'latino', 'latinx'] },
      { key: 'race', label: 'Race / Ethnicity', type: 'choice',
        choices: ['American Indian or Alaska Native', 'Asian', 'Black or African American',
                  'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander', 'White',
                  'Two or More Races', 'Decline to self-identify'],
        keywords: ['race ethnicity', 'ethnicity', 'race', 'racial', 'ethnic'] },
      { key: 'veteran', label: 'Veteran status', type: 'choice',
        choices: ['I am not a protected veteran',
                  'I identify as one or more of the classifications of a protected veteran',
                  'I do not wish to answer'],
        keywords: ['protected veteran', 'veteran status', 'veteran', 'military'] },
      { key: 'disability', label: 'Disability status', type: 'choice',
        choices: ['Yes, I have a disability', 'No, I do not have a disability', 'I do not wish to answer'],
        keywords: ['disability status', 'disability', 'disabled'] },
    ],
  },
];

// Flat list of every field, in declaration order.
var FIELD_LIST = FIELD_GROUPS.reduce(function (acc, g) { return acc.concat(g.fields); }, []);

if (typeof window !== 'undefined') {
  window.FIELD_GROUPS = FIELD_GROUPS;
  window.FIELD_LIST = FIELD_LIST;
}
