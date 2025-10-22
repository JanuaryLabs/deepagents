---
# User Stories

## Login with Pending Status for New Users

As a **new customer or vendor**, I want to **log in after account creation**, so that **access the system while awaiting admin approval**.

**Acceptance Criteria:**
1. User can enter valid credentials and reach the dashboard.  
2. System displays a pending status indicator on the dashboard.  
3. User is not automatically redirected to an error page after login.

## Display Pending Approval Banner

As a **new customer or vendor**, I want to **see a banner indicating account pending approval**, so that **understand that account is awaiting admin approval**.

**Acceptance Criteria:**
1. Banner is visible on all pages after login.  
2. Banner text matches “Your account is pending admin approval”.  
3. Banner does not obstruct primary content.

## Prevent Write Actions Until Approval

As a **new customer or vendor**, I want to **attempt to perform write actions**, so that **ensure system integrity until admin approval**.

**Acceptance Criteria:**
1. Any attempt to create, update, or delete data is blocked.  
2. User receives a clear error message stating “Account pending approval. Write actions are disabled.”  
3. Read‑only actions remain accessible.

## Admin Approves Pending User Accounts

As an **admin**, I want to **approve pending user accounts**, so that **enable users to perform write actions and fully use the system**.

**Acceptance Criteria:**
1. Admin can view a list of users with pending status.  
2. Admin can select a user and change status to active.  
3. User receives notification of approval and the banner disappears.
---