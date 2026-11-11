-- QC-910: one order-notify SMS row with a reply link, as if the Vendor-only offer $(OrderAssignmentId) had been texted to
-- $(RecipientUserId), without sending anything (the local Twilio sender may be live). Used by the dispatch-contact cases
-- (tests/app/dispatch-contact.spec.ts) to prove the reply link compares against the offer recipient (the Vendor's dispatch
-- contact), not the assignment's empty DriverUserId.
--   $(CodeHash) is the lowercase SHA-256 of the link code the test made; the code itself is never stored.
-- Only an assignment of an 'E2E QC-910 %' vendor is accepted. host-qc910.remove.sql deletes the message and its link.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @AssignmentId int = $(OrderAssignmentId);
DECLARE @RecipientUserId nvarchar(450) = N'$(RecipientUserId)';
DECLARE @VendorId int = (SELECT a.VendorID_FK FROM app.OrderAssignments a JOIN auth.Organisations o ON o.OrganisationID = a.VendorID_FK
                         WHERE a.OrderAssignmentID = @AssignmentId AND o.OrganisationName LIKE N'E2E QC-910 %');
IF @VendorId IS NULL
    THROW 50001, 'The assignment is not one of the QC-910 throwaway vendors.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Users WHERE Id = @RecipientUserId AND NormalizedEmail LIKE N'E2E.QC910.%@QUARRYCONNECT.TEST')
    THROW 50002, 'The recipient is not a QC-910 throwaway user.', 1;

BEGIN TRANSACTION;

INSERT app.Messages (Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, MessageBody, PhoneNumber, SentAt, IsActioned, Direction, MessageType, Channel, MessageUUID)
SELECT GETUTCDATE(), GETUTCDATE(), 1, @AssignmentId, @RecipientUserId, @VendorId, N'e2e-qc910 Vendor-only offer', u.PhoneNumber, GETUTCDATE(), 0, 20, 10, 10, NEWID()
FROM auth.Users u WHERE u.Id = @RecipientUserId;
DECLARE @MessageId int = SCOPE_IDENTITY();

INSERT app.MessageReplyLinks (MessageID_FK, CodeHash, ExpiresAt, Created, Updated, Active)
VALUES (@MessageId, '$(CodeHash)', DATEADD(DAY, 1, GETUTCDATE()), GETUTCDATE(), GETUTCDATE(), 1);

COMMIT TRANSACTION;

SELECT CONCAT('SEEDED message=', @MessageId);
